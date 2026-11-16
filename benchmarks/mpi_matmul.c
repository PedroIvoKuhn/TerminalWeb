#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <unistd.h>
#include <mpi.h>

#define DEFAULT_N 4800
#define DEFAULT_REPS 30

/*
 * Inicializa a matriz com um valor constante em precisão dupla.
 * Usa size_t para garantir suporte a matrizes de grandes dimensões sem overflow.
 */
static void init_matrix(double *mat, int size, double val) {
    size_t total = (size_t)size * size;
    for (size_t i = 0; i < total; i++) {
        mat[i] = val;
    }
}

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

    // 1. Parametrização via CLI: ./mpi_matmul [N] [REPS]
    int N = DEFAULT_N;
    int reps = DEFAULT_REPS;

    if (argc > 1) {
        N = atoi(argv[1]);
    }
    if (argc > 2) {
        reps = atoi(argv[2]);
    }

    if (N <= 0 || reps <= 0) {
        if (rank == 0) {
            fprintf(stderr, "Erro: N e REPS devem ser inteiros positivos. (Recebido: N=%d, REPS=%d)\n", N, reps);
        }
        MPI_Finalize();
        return 1;
    }

    // Verificação de divisibilidade estrita
    if (N % num_procs != 0) {
        if (rank == 0) {
            printf("Erro: N (%d) deve ser divisivel pelo numero de processos (%d)\n", N, num_procs);
        }
        MPI_Finalize();
        return 1;
    }

    int rows_per_proc = N / num_procs;
    size_t total_elements = (size_t)N * N;
    size_t sub_elements = (size_t)rows_per_proc * N;

    // 2. Economia de Memória no Pod Master via MPI_IN_PLACE
    // Rank 0: Apenas A, B e C (~553 MB para N=4800). Sem sub_A nem sub_C.
    // Workers (rank > 0): A=NULL, C=NULL; aloca B, sub_A e sub_C.
    double *A = NULL;
    double *B = (double *)malloc(total_elements * sizeof(double));
    double *C = NULL;
    double *sub_A = NULL;
    double *sub_C = NULL;

    if (!B) {
        fprintf(stderr, "[Rank %d] Falha crítica ao alocar matriz B (%zu bytes)\n",
                rank, total_elements * sizeof(double));
        MPI_Abort(MPI_COMM_WORLD, 1);
    }

    if (rank == 0) {
        A = (double *)malloc(total_elements * sizeof(double));
        C = (double *)malloc(total_elements * sizeof(double));
        if (!A || !C) {
            fprintf(stderr, "[Rank 0] Falha crítica ao alocar matrizes A ou C (%zu bytes cada)\n",
                    total_elements * sizeof(double));
            MPI_Abort(MPI_COMM_WORLD, 1);
        }
        // Inicializa matrizes uma única vez fora do laço
        init_matrix(A, N, 1.5);
        init_matrix(B, N, 2.0);
    } else {
        sub_A = (double *)malloc(sub_elements * sizeof(double));
        sub_C = (double *)malloc(sub_elements * sizeof(double));
        if (!sub_A || !sub_C) {
            fprintf(stderr, "[Rank %d] Falha crítica ao alocar sub_A ou sub_C (%zu bytes cada)\n",
                    rank, sub_elements * sizeof(double));
            MPI_Abort(MPI_COMM_WORLD, 1);
        }
    }

    // Ponteiros locais para computação e buffers de trabalho:
    // No Rank 0, local_A e local_C apontam diretamente para o início de A e C
    double *local_A = (rank == 0) ? A : sub_A;
    double *local_C = (rank == 0) ? C : sub_C;

    // Buffers para armazenamento de amostras estatísticas no Rank 0
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
            fprintf(stderr, "[Rank 0] Falha ao alocar buffers de telemetria estatística\n");
            MPI_Abort(MPI_COMM_WORLD, 1);
        }
    }

    // =========================================================================
    // 3. Warm-up Inteligente (Aquecimento de Rede e Resolução IFUNC)
    // Transmite os buffers reais para aquecer a janela TCP (WireGuard) e BTL,
    // mas calcula apenas um lote representativo de linhas (<= 16) para aquecer
    // o pipeline vetorial sem desperdiçar dezenas de segundos na CPU.
    // =========================================================================
    MPI_Barrier(MPI_COMM_WORLD);
    MPI_Bcast(B, (int)total_elements, MPI_DOUBLE, 0, MPI_COMM_WORLD);

    if (rank == 0) {
        MPI_Scatter(A, (int)sub_elements, MPI_DOUBLE,
                    MPI_IN_PLACE, 0, MPI_DATATYPE_NULL,
                    0, MPI_COMM_WORLD);
    } else {
        MPI_Scatter(NULL, 0, MPI_DATATYPE_NULL,
                    sub_A, (int)sub_elements, MPI_DOUBLE,
                    0, MPI_COMM_WORLD);
    }

    memset(local_C, 0, sub_elements * sizeof(double));
    int warmup_rows = (rows_per_proc < 16) ? rows_per_proc : 16;
    for (int i = 0; i < warmup_rows; i++) {
        for (int k = 0; k < N; k++) {
            double r = local_A[i * N + k];
            for (int j = 0; j < N; j++) {
                local_C[i * N + j] += r * B[k * N + j];
            }
        }
    }

    MPI_Barrier(MPI_COMM_WORLD);

    if (rank == 0) {
        MPI_Gather(MPI_IN_PLACE, 0, MPI_DATATYPE_NULL,
                   C, (int)sub_elements, MPI_DOUBLE,
                   0, MPI_COMM_WORLD);
    } else {
        MPI_Gather(sub_C, (int)sub_elements, MPI_DOUBLE,
                   NULL, 0, MPI_DATATYPE_NULL,
                   0, MPI_COMM_WORLD);
    }
    MPI_Barrier(MPI_COMM_WORLD);
    sleep(1);

    // =========================================================================
    // 4. Laço Interno Cronometrado de Repetições (iter = 1 até REPS)
    // =========================================================================
    for (int iter = 1; iter <= reps; iter++) {
        // Barreira pré-Bcast: marco zero do ciclo completo (t_total)
        MPI_Barrier(MPI_COMM_WORLD);
        double t_cycle_start = MPI_Wtime();

        // 4.1 Broadcast de B
        double t_bcast_start = MPI_Wtime();
        MPI_Bcast(B, (int)total_elements, MPI_DOUBLE, 0, MPI_COMM_WORLD);
        double t_bcast_end = MPI_Wtime();
        double t_bcast_local = t_bcast_end - t_bcast_start;

        // 4.2 Scatter de A (com MPI_IN_PLACE no Rank 0)
        double t_scat_start = MPI_Wtime();
        if (rank == 0) {
            MPI_Scatter(A, (int)sub_elements, MPI_DOUBLE,
                        MPI_IN_PLACE, 0, MPI_DATATYPE_NULL,
                        0, MPI_COMM_WORLD);
        } else {
            MPI_Scatter(NULL, 0, MPI_DATATYPE_NULL,
                        sub_A, (int)sub_elements, MPI_DOUBLE,
                        0, MPI_COMM_WORLD);
        }
        double t_scat_end = MPI_Wtime();
        double t_scatter_local = t_scat_end - t_scat_start;

        // 4.3 Computação Local Exclusiva (memset antes do cronômetro)
        memset(local_C, 0, sub_elements * sizeof(double));
        double t_comp_start = MPI_Wtime();
        for (int i = 0; i < rows_per_proc; i++) {
            for (int k = 0; k < N; k++) {
                double r = local_A[i * N + k];
                for (int j = 0; j < N; j++) {
                    local_C[i * N + j] += r * B[k * N + j];
                }
            }
        }
        double t_comp_end = MPI_Wtime();
        double t_comp_local = t_comp_end - t_comp_start;

        // 4.4 Barreira pós-computação para medição do desbalanceamento (straggler effect)
        double t_straggler_start = MPI_Wtime();
        MPI_Barrier(MPI_COMM_WORLD);
        double t_straggler_end = MPI_Wtime();
        double t_straggler_local = t_straggler_end - t_straggler_start;

        // 4.5 Gather de C (com MPI_IN_PLACE no Rank 0)
        double t_gather_start = MPI_Wtime();
        if (rank == 0) {
            MPI_Gather(MPI_IN_PLACE, 0, MPI_DATATYPE_NULL,
                       C, (int)sub_elements, MPI_DOUBLE,
                       0, MPI_COMM_WORLD);
        } else {
            MPI_Gather(sub_C, (int)sub_elements, MPI_DOUBLE,
                       NULL, 0, MPI_DATATYPE_NULL,
                       0, MPI_COMM_WORLD);
        }
        double t_gather_end = MPI_Wtime();
        double t_gather_local = t_gather_end - t_gather_start;

        // 4.6 Término do ciclo completo
        double t_total_local = t_gather_end - t_cycle_start;

        // Reduções para consolidação estatística no Rank 0
        double t_comp_max = 0.0, t_comp_min = 0.0;
        double t_straggler_max = 0.0;
        double t_bcast_max = 0.0, t_scatter_max = 0.0, t_gather_max = 0.0;
        double t_total_max = 0.0;

        MPI_Reduce(&t_comp_local, &t_comp_max, 1, MPI_DOUBLE, MPI_MAX, 0, MPI_COMM_WORLD);
        MPI_Reduce(&t_comp_local, &t_comp_min, 1, MPI_DOUBLE, MPI_MIN, 0, MPI_COMM_WORLD);
        MPI_Reduce(&t_straggler_local, &t_straggler_max, 1, MPI_DOUBLE, MPI_MAX, 0, MPI_COMM_WORLD);

        MPI_Reduce(&t_bcast_local, &t_bcast_max, 1, MPI_DOUBLE, MPI_MAX, 0, MPI_COMM_WORLD);
        MPI_Reduce(&t_scatter_local, &t_scatter_max, 1, MPI_DOUBLE, MPI_MAX, 0, MPI_COMM_WORLD);
        MPI_Reduce(&t_gather_local, &t_gather_max, 1, MPI_DOUBLE, MPI_MAX, 0, MPI_COMM_WORLD);
        MPI_Reduce(&t_total_local, &t_total_max, 1, MPI_DOUBLE, MPI_MAX, 0, MPI_COMM_WORLD);

        if (rank == 0) {
            double t_total = t_total_max;
            double t_bcast = t_bcast_max;
            double t_scatter = t_scatter_max;
            double t_gather = t_gather_max;
            double t_rede = t_bcast + t_scatter + t_gather;
            double t_straggler_wait = t_straggler_max;

            // Armazena para consolidação final
            samples_total[iter - 1] = t_total;
            samples_rede[iter - 1] = t_rede;
            samples_comp_max[iter - 1] = t_comp_max;
            samples_straggler[iter - 1] = t_straggler_wait;

            // Log CSV por amostra
            printf("AMOSTRA_CPU_BOUND,iter=%d,np=%d,N=%d,t_total=%.4f,t_rede=%.4f,t_bcast=%.4f,t_scatter=%.4f,t_gather=%.4f,t_comp_max=%.4f,t_comp_min=%.4f,t_straggler_wait=%.4f\n",
                   iter, num_procs, N, t_total, t_rede, t_bcast, t_scatter, t_gather,
                   t_comp_max, t_comp_min, t_straggler_wait);
            fflush(stdout);
        }

        // Pausa inter-amostra de 2s para alívio térmico da CPU e recomposição de rajada
        // (2s preserva túnel WireGuard e buffers TCP BTL 100% aquecidos, cujo timeout é de 25s+)
        if (iter < reps) {
            MPI_Barrier(MPI_COMM_WORLD);
            sleep(2);
        }
    }

    // =========================================================================
    // 5. Resumo Estatístico Final (Média, Desvio Padrão e IC 95%)
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

        printf("RESUMO_ESTATISTICO,np=%d,N=%d,reps=%d,media_total=%.4f,sd_total=%.4f,ic95_total=%.4f,media_rede=%.4f,sd_rede=%.4f,media_comp_max=%.4f,sd_comp_max=%.4f,media_straggler=%.4f\n",
               num_procs, N, reps,
               media_total, sd_total, ic95_total,
               media_rede, sd_rede,
               media_comp_max, sd_comp_max,
               media_straggler);
        fflush(stdout);

        free(A);
        free(C);
        free(samples_total);
        free(samples_rede);
        free(samples_comp_max);
        free(samples_straggler);
    } else {
        free(sub_A);
        free(sub_C);
    }

    free(B);

    MPI_Finalize();
    return 0;
}
