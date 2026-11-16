#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <unistd.h>
#include <mpi.h>

#define DEFAULT_ROWS 2000
#define DEFAULT_COLS 2000
#define DEFAULT_STEPS 800
#define DEFAULT_REPS 30

/*
 * Calcula Média Amostral (mean), Desvio Padrão Amostral (sd)
 * e Intervalo de Confiança de 95% (ic95) para um conjunto de amostras.
 * ic95 = 1.96 * sd / sqrt(n)
 */
static void calc_stats(const double *data, int n, double *mean, double *sd, double *ic95) {
    if (n <= 0) {
        *mean = 0.0;
        *sd = 0.0;
        *ic95 = 0.0;
        return;
    }

    double sum = 0.0;
    for (int i = 0; i < n; i++) {
        sum += data[i];
    }
    *mean = sum / n;

    if (n > 1) {
        double sum_sq_diff = 0.0;
        for (int i = 0; i < n; i++) {
            double diff = data[i] - *mean;
            sum_sq_diff += diff * diff;
        }
        *sd = sqrt(sum_sq_diff / (n - 1));
        *ic95 = 1.96 * (*sd) / sqrt((double)n);
    } else {
        *sd = 0.0;
        *ic95 = 0.0;
    }
}

int main(int argc, char **argv) {
    int rank, num_procs;

    MPI_Init(&argc, &argv);
    MPI_Comm_rank(MPI_COMM_WORLD, &rank);
    MPI_Comm_size(MPI_COMM_WORLD, &num_procs);

    // 1. Parametrização via CLI flexível:
    // ./mpi_heat2d [ROWS] [STEPS] [REPS] ou ./mpi_heat2d [ROWS] [COLS] [STEPS] [REPS]
    int rows = DEFAULT_ROWS;
    int cols = DEFAULT_COLS;
    int steps = DEFAULT_STEPS;
    int reps = DEFAULT_REPS;

    if (argc == 2) {
        rows = atoi(argv[1]);
        cols = rows;
    } else if (argc == 3) {
        rows = atoi(argv[1]);
        cols = rows;
        steps = atoi(argv[2]);
    } else if (argc == 4) {
        rows = atoi(argv[1]);
        cols = rows;
        steps = atoi(argv[2]);
        reps = atoi(argv[3]);
    } else if (argc >= 5) {
        rows = atoi(argv[1]);
        cols = atoi(argv[2]);
        steps = atoi(argv[3]);
        reps = atoi(argv[4]);
    }

    if (rows <= 0 || cols <= 0 || steps <= 0 || reps <= 0) {
        if (rank == 0) {
            fprintf(stderr, "Erro: Dimensões, iterações e reps devem ser inteiros positivos.\n");
        }
        MPI_Finalize();
        return 1;
    }

    // Verificação de divisibilidade
    if (rows % num_procs != 0) {
        if (rank == 0) {
            printf("Erro: ROWS (%d) deve ser divisivel por num_procs (%d)\n", rows, num_procs);
        }
        MPI_Finalize();
        return 1;
    }

    int local_rows = rows / num_procs;
    size_t grid_elements = (size_t)(local_rows + 2) * cols;

    // Alocação das grades locais com bordas fantasma (ghost rows)
    double *curr = (double *)malloc(grid_elements * sizeof(double));
    double *next = (double *)malloc(grid_elements * sizeof(double));

    if (!curr || !next) {
        fprintf(stderr, "[Rank %d] Falha crítica de alocação de memória (%zu bytes)\n",
                rank, grid_elements * sizeof(double));
        MPI_Abort(MPI_COMM_WORLD, 1);
    }

    int prev_rank = (rank > 0) ? rank - 1 : MPI_PROC_NULL;
    int next_rank = (rank < num_procs - 1) ? rank + 1 : MPI_PROC_NULL;

    // Buffers estatísticos no Rank 0
    double *samples_total = NULL;
    double *samples_rede = NULL;
    double *samples_comp_max = NULL;
    double *samples_straggler = NULL;

    if (rank == 0) {
        samples_total = (double *)malloc(reps * sizeof(double));
        samples_rede = (double *)malloc(reps * sizeof(double));
        samples_comp_max = (double *)malloc(reps * sizeof(double));
        samples_straggler = (double *)malloc(reps * sizeof(double));
        if (!samples_total || !samples_rede || !samples_comp_max || !samples_straggler) {
            fprintf(stderr, "[Rank 0] Falha ao alocar telemetria estatística\n");
            MPI_Abort(MPI_COMM_WORLD, 1);
        }
    }

    // =========================================================================
    // 2. Warm-up Inteligente (10 passos temporais)
    // Aquece canais TCP WireGuard, buffers de socket de 4MB e caches sem atraso
    // =========================================================================
    for (size_t i = 0; i < grid_elements; i++) {
        curr[i] = 20.0;
        next[i] = 20.0;
    }

    MPI_Barrier(MPI_COMM_WORLD);
    int warmup_steps = (steps < 10) ? steps : 10;
    for (int step = 0; step < warmup_steps; step++) {
        MPI_Sendrecv(&curr[1 * cols], cols, MPI_DOUBLE, prev_rank, 0,
                     &curr[0 * cols], cols, MPI_DOUBLE, prev_rank, 1,
                     MPI_COMM_WORLD, MPI_STATUS_IGNORE);

        MPI_Sendrecv(&curr[local_rows * cols], cols, MPI_DOUBLE, next_rank, 1,
                     &curr[(local_rows + 1) * cols], cols, MPI_DOUBLE, next_rank, 0,
                     MPI_COMM_WORLD, MPI_STATUS_IGNORE);

        for (int i = 1; i <= local_rows; i++) {
            for (int j = 1; j < cols - 1; j++) {
                next[i * cols + j] = 0.25 * (
                    curr[(i - 1) * cols + j] +
                    curr[(i + 1) * cols + j] +
                    curr[i * cols + (j - 1)] +
                    curr[i * cols + (j + 1)]
                );
            }
        }
        double *tmp = curr;
        curr = next;
        next = tmp;
    }
    MPI_Barrier(MPI_COMM_WORLD);
    sleep(1);

    // =========================================================================
    // 3. Laço Cronometrado de Repetições (iter = 1 até REPS)
    // =========================================================================
    for (int iter = 1; iter <= reps; iter++) {
        // Reinicializa o estado térmico para reprodutibilidade estrita
        for (size_t i = 0; i < grid_elements; i++) {
            curr[i] = 20.0;
            next[i] = 20.0;
        }

        MPI_Barrier(MPI_COMM_WORLD);
        double t_cycle_start = MPI_Wtime();

        double t_rede_acc = 0.0;
        double t_comp_acc = 0.0;

        for (int step = 0; step < steps; step++) {
            // 3.1 Troca de bordas com vizinhos imediatos (Halo Exchange)
            double t_halo_start = MPI_Wtime();
            MPI_Sendrecv(&curr[1 * cols], cols, MPI_DOUBLE, prev_rank, 0,
                         &curr[0 * cols], cols, MPI_DOUBLE, prev_rank, 1,
                         MPI_COMM_WORLD, MPI_STATUS_IGNORE);

            MPI_Sendrecv(&curr[local_rows * cols], cols, MPI_DOUBLE, next_rank, 1,
                         &curr[(local_rows + 1) * cols], cols, MPI_DOUBLE, next_rank, 0,
                         MPI_COMM_WORLD, MPI_STATUS_IGNORE);
            double t_halo_end = MPI_Wtime();
            t_rede_acc += (t_halo_end - t_halo_start);

            // 3.2 Atualização dos pontos térmicos pelo estêncil de 5 pontos
            double t_stencil_start = MPI_Wtime();
            for (int i = 1; i <= local_rows; i++) {
                for (int j = 1; j < cols - 1; j++) {
                    next[i * cols + j] = 0.25 * (
                        curr[(i - 1) * cols + j] +
                        curr[(i + 1) * cols + j] +
                        curr[i * cols + (j - 1)] +
                        curr[i * cols + (j + 1)]
                    );
                }
            }
            double *tmp = curr;
            curr = next;
            next = tmp;
            double t_stencil_end = MPI_Wtime();
            t_comp_acc += (t_stencil_end - t_stencil_start);
        }

        // 3.3 Barreira pós-estêncil para medição do desbalanceamento (straggler effect)
        double t_straggler_start = MPI_Wtime();
        MPI_Barrier(MPI_COMM_WORLD);
        double t_straggler_end = MPI_Wtime();
        double t_straggler_local = t_straggler_end - t_straggler_start;

        double t_total_local = t_straggler_end - t_cycle_start;

        // Reduções para consolidação estatística no Rank 0
        double t_comp_max = 0.0, t_comp_min = 0.0;
        double t_straggler_max = 0.0;
        double t_rede_max = 0.0;
        double t_total_max = 0.0;

        MPI_Reduce(&t_comp_acc, &t_comp_max, 1, MPI_DOUBLE, MPI_MAX, 0, MPI_COMM_WORLD);
        MPI_Reduce(&t_comp_acc, &t_comp_min, 1, MPI_DOUBLE, MPI_MIN, 0, MPI_COMM_WORLD);
        MPI_Reduce(&t_straggler_local, &t_straggler_max, 1, MPI_DOUBLE, MPI_MAX, 0, MPI_COMM_WORLD);
        MPI_Reduce(&t_rede_acc, &t_rede_max, 1, MPI_DOUBLE, MPI_MAX, 0, MPI_COMM_WORLD);
        MPI_Reduce(&t_total_local, &t_total_max, 1, MPI_DOUBLE, MPI_MAX, 0, MPI_COMM_WORLD);

        if (rank == 0) {
            double t_total = t_total_max;
            double t_rede = t_rede_max;
            double t_straggler_wait = t_straggler_max;

            // Armazena para consolidação final
            samples_total[iter - 1] = t_total;
            samples_rede[iter - 1] = t_rede;
            samples_comp_max[iter - 1] = t_comp_max;
            samples_straggler[iter - 1] = t_straggler_wait;

            // Log CSV por amostra
            printf("AMOSTRA_NETWORK_BOUND,iter=%d,np=%d,linhas=%d,colunas=%d,iteracoes=%d,t_total=%.4f,t_rede=%.4f,t_comp_max=%.4f,t_comp_min=%.4f,t_straggler_wait=%.4f\n",
                   iter, num_procs, rows, cols, steps, t_total, t_rede,
                   t_comp_max, t_comp_min, t_straggler_wait);
            fflush(stdout);
        }

        // Pausa inter-amostra de 2s para resfriamento térmico e alívio de créditos de CPU
        // (2s preserva túnel Tailscale WireGuard e conexões TCP BTL totalmente aquecidos)
        if (iter < reps) {
            MPI_Barrier(MPI_COMM_WORLD);
            sleep(2);
        }
    }

    // =========================================================================
    // 4. Resumo Estatístico Final (Média, Desvio Padrão e IC 95%)
    // =========================================================================
    if (rank == 0) {
        double media_total, sd_total, ic95_total;
        double media_rede, sd_rede, ic95_rede;
        double media_comp_max, sd_comp_max, ic95_comp_max;
        double media_straggler, sd_straggler, ic95_straggler;

        calc_stats(samples_total, reps, &media_total, &sd_total, &ic95_total);
        calc_stats(samples_rede, reps, &media_rede, &sd_rede, &ic95_rede);
        calc_stats(samples_comp_max, reps, &media_comp_max, &sd_comp_max, &ic95_comp_max);
        calc_stats(samples_straggler, reps, &media_straggler, &sd_straggler, &ic95_straggler);

        printf("RESUMO_ESTATISTICO_NETWORK,np=%d,linhas=%d,colunas=%d,iteracoes=%d,reps=%d,media_total=%.4f,sd_total=%.4f,ic95_total=%.4f,media_rede=%.4f,sd_rede=%.4f,media_comp_max=%.4f,sd_comp_max=%.4f,media_straggler=%.4f\n",
               num_procs, rows, cols, steps, reps,
               media_total, sd_total, ic95_total,
               media_rede, sd_rede,
               media_comp_max, sd_comp_max,
               media_straggler);
        fflush(stdout);

        free(samples_total);
        free(samples_rede);
        free(samples_comp_max);
        free(samples_straggler);
    }

    free(curr);
    free(next);

    MPI_Finalize();
    return 0;
}
