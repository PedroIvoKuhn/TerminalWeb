#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <unistd.h>
#include <time.h>
#include <mpi.h>

#define DEFAULT_SAMPLES 2500000000LL // 2.5 bilhão de amostras totais
#define DEFAULT_REPS 30

/*
 * Gerador de números pseudoaleatórios SplitMix64 para inicialização
 * de sementes independentes por processo MPI.
 */
static inline uint64_t splitmix64(uint64_t *state) {
    uint64_t z = (*state += 0x9E3779B97F4A7C15ULL);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
}

/*
 * Gerador XorShift64* de altíssima performance.
 * Converte para precisão dupla (double) no intervalo [0, 1) com 53 bits de mantissa IEEE 754.
 * Executa em ~2 ciclos de clock na CPU, garantindo 100% de ocupação na ALU/FPU.
 */
static inline double get_random(uint64_t *state) {
    uint64_t x = *state;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    *state = x;
    uint64_t result = x * 0x2545F4914F6CDD1DULL;
    return (double)(result >> 11) * (1.0 / (double)(1ULL << 53));
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

    // 1. Parametrização via CLI: ./mpi_montecarlo [SAMPLES] [REPS]
    long long total_samples = DEFAULT_SAMPLES;
    int reps = DEFAULT_REPS;

    if (argc > 1) {
        total_samples = atoll(argv[1]);
    }
    if (argc > 2) {
        reps = atoi(argv[2]);
    }

    if (total_samples <= 0 || reps <= 0) {
        if (rank == 0) {
            fprintf(stderr, "Erro: SAMPLES e REPS devem ser inteiros positivos. (Recebido: SAMPLES=%lld, REPS=%d)\n",
                    total_samples, reps);
        }
        MPI_Finalize();
        return 1;
    }

    // Ajusta total_samples para ser exatamente divisível por num_procs
    long long samples_per_proc = total_samples / num_procs;
    total_samples = samples_per_proc * num_procs;

    // Inicialização de semente pseudoaleatória independente e não correlacionada por rank
    uint64_t base_seed = 0;
    if (rank == 0) {
        base_seed = (uint64_t)time(NULL);
    }
    MPI_Bcast(&base_seed, 1, MPI_UNSIGNED_LONG_LONG, 0, MPI_COMM_WORLD);

    // Cada rank gera seu fluxo estritamente descorrelacionado
    uint64_t seed_state = base_seed + ((uint64_t)rank * 0x9E3779B97F4A7C15ULL + 1ULL);
    for (int k = 0; k < 16; k++) {
        splitmix64(&seed_state);
    }
    uint64_t rng_state = seed_state;

    // Buffers estatísticos no Rank 0
    double *samples_total = NULL;
    double *samples_rede = NULL;
    double *samples_comp_max = NULL;
    double *samples_straggler = NULL;
    double *samples_pi = NULL;

    if (rank == 0) {
        samples_total = (double *)malloc(reps * sizeof(double));
        samples_rede = (double *)malloc(reps * sizeof(double));
        samples_comp_max = (double *)malloc(reps * sizeof(double));
        samples_straggler = (double *)malloc(reps * sizeof(double));
        samples_pi = (double *)malloc(reps * sizeof(double));
        if (!samples_total || !samples_rede || !samples_comp_max || !samples_straggler || !samples_pi) {
            fprintf(stderr, "[Rank 0] Falha ao alocar buffers de telemetria estatística\n");
            MPI_Abort(MPI_COMM_WORLD, 1);
        }
    }

    // =========================================================================
    // 2. Warm-up Rápido (Aquecimento de Pipelines Vetoriais e Buffers de Rede)
    // Sorteia 5 milhões de pontos por rank para aquecer registradores e cache
    // sem introduzir atraso perceptível no ensaio.
    // =========================================================================
    MPI_Barrier(MPI_COMM_WORLD);
    long long warmup_samples = 5000000LL;
    long long warmup_hits = 0;
    for (long long i = 0; i < warmup_samples; i++) {
        double x = get_random(&rng_state);
        double y = get_random(&rng_state);
        if (x * x + y * y <= 1.0) {
            warmup_hits++;
        }
    }
    long long global_warmup_hits = 0;
    MPI_Reduce(&warmup_hits, &global_warmup_hits, 1, MPI_LONG_LONG, MPI_SUM, 0, MPI_COMM_WORLD);
    MPI_Barrier(MPI_COMM_WORLD);
    sleep(1);

    // =========================================================================
    // 3. Laço Interno Cronometrado de Repetições (iter = 1 até REPS)
    // =========================================================================
    for (int iter = 1; iter <= reps; iter++) {
        // Barreira pré-cálculo: marco zero da iteração
        MPI_Barrier(MPI_COMM_WORLD);
        double t_cycle_start = MPI_Wtime();

        // 3.1 Computação Local Exclusiva (100% CPU-Bound / Zero Network)
        double t_comp_start = MPI_Wtime();
        long long local_hits = 0;
        for (long long i = 0; i < samples_per_proc; i++) {
            double x = get_random(&rng_state);
            double y = get_random(&rng_state);
            if (x * x + y * y <= 1.0) {
                local_hits++;
            }
        }
        double t_comp_end = MPI_Wtime();
        double t_comp_local = t_comp_end - t_comp_start;

        // 3.2 Barreira pós-computação para medição do efeito de nó lento (Straggler Effect)
        // Como o volume de trabalho é matematicamente idêntico, qualquer espera
        // é 100% decorrente da diferença de poder computacional entre nós locais e nuvem.
        double t_straggler_start = MPI_Wtime();
        MPI_Barrier(MPI_COMM_WORLD);
        double t_straggler_end = MPI_Wtime();
        double t_straggler_local = t_straggler_end - t_straggler_start;

        // 3.3 Redução Escalar do Resultado (Única transmissão de rede de todo o benchmark)
        double t_rede_start = MPI_Wtime();
        long long total_hits = 0;
        MPI_Reduce(&local_hits, &total_hits, 1, MPI_LONG_LONG, MPI_SUM, 0, MPI_COMM_WORLD);
        double t_rede_end = MPI_Wtime();
        double t_rede_local = t_rede_end - t_rede_start;

        // Ciclo total local
        double t_total_local = t_rede_end - t_cycle_start;

        // Reduções de métricas para consolidação analítica no Rank 0
        double t_comp_max = 0.0, t_comp_min = 0.0;
        double t_straggler_max = 0.0;
        double t_rede_max = 0.0;
        double t_total_max = 0.0;

        MPI_Reduce(&t_comp_local, &t_comp_max, 1, MPI_DOUBLE, MPI_MAX, 0, MPI_COMM_WORLD);
        MPI_Reduce(&t_comp_local, &t_comp_min, 1, MPI_DOUBLE, MPI_MIN, 0, MPI_COMM_WORLD);
        MPI_Reduce(&t_straggler_local, &t_straggler_max, 1, MPI_DOUBLE, MPI_MAX, 0, MPI_COMM_WORLD);
        MPI_Reduce(&t_rede_local, &t_rede_max, 1, MPI_DOUBLE, MPI_MAX, 0, MPI_COMM_WORLD);
        MPI_Reduce(&t_total_local, &t_total_max, 1, MPI_DOUBLE, MPI_MAX, 0, MPI_COMM_WORLD);

        if (rank == 0) {
            double pi_estimado = 4.0 * (double)total_hits / (double)total_samples;
            double t_total = t_total_max;
            double t_rede = t_rede_max;
            double t_straggler_wait = t_straggler_max;

            // Armazena amostra
            samples_total[iter - 1] = t_total;
            samples_rede[iter - 1] = t_rede;
            samples_comp_max[iter - 1] = t_comp_max;
            samples_straggler[iter - 1] = t_straggler_wait;
            samples_pi[iter - 1] = pi_estimado;

            // Emissão de log individual de amostra (idêntico ao padrão dos outros benchmarks)
            printf("AMOSTRA_MONTECARLO,iter=%d,np=%d,amostras=%lld,t_total=%.4f,t_rede=%.4f,t_comp_max=%.4f,t_comp_min=%.4f,t_straggler_wait=%.4f,pi=%.7f\n",
                   iter, num_procs, total_samples, t_total, t_rede,
                   t_comp_max, t_comp_min, t_straggler_wait, pi_estimado);
            fflush(stdout);
        }

        // Pausa inter-amostra de 2s para alívio térmico da CPU e recomposição de rajada
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
        double media_pi, sd_pi, ic95_pi;

        calc_stats(samples_total, reps, &media_total, &sd_total, &ic95_total);
        calc_stats(samples_rede, reps, &media_rede, &sd_rede, &ic95_rede);
        calc_stats(samples_comp_max, reps, &media_comp_max, &sd_comp_max, &ic95_comp_max);
        calc_stats(samples_straggler, reps, &media_straggler, &sd_straggler, &ic95_straggler);
        calc_stats(samples_pi, reps, &media_pi, &sd_pi, &ic95_pi);

        printf("RESUMO_ESTATISTICO_MONTECARLO,np=%d,amostras=%lld,reps=%d,media_total=%.4f,sd_total=%.4f,ic95_total=%.4f,media_rede=%.4f,sd_rede=%.4f,media_comp_max=%.4f,sd_comp_max=%.4f,media_straggler=%.4f,pi_medio=%.7f\n",
               num_procs, total_samples, reps,
               media_total, sd_total, ic95_total,
               media_rede, sd_rede,
               media_comp_max, sd_comp_max,
               media_straggler, media_pi);
        fflush(stdout);

        free(samples_total);
        free(samples_rede);
        free(samples_comp_max);
        free(samples_straggler);
        free(samples_pi);
    }

    MPI_Finalize();
    return 0;
}
