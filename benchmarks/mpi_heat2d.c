#include <stdio.h>
#include <stdlib.h>
#include <mpi.h>

#define ROWS 2000
#define COLS 2000
#define ITERATIONS 800

int main(int argc, char **argv) {
    int rank, num_procs;
    double start_time, end_time;

    MPI_Init(&argc, &argv);
    MPI_Comm_rank(MPI_COMM_WORLD, &rank);
    MPI_Comm_size(MPI_COMM_WORLD, &num_procs);

    if (ROWS % num_procs != 0) {
        if (rank == 0) {
            printf("Erro: ROWS (%d) deve ser divisivel por num_procs (%d)\n", ROWS, num_procs);
        }
        MPI_Finalize();
        return 1;
    }

    int local_rows = ROWS / num_procs;
    
    // Matrizes locais com linhas extras para as bordas fantasma (ghost rows)
    double *curr = (double *)malloc((local_rows + 2) * COLS * sizeof(double));
    double *next = (double *)malloc((local_rows + 2) * COLS * sizeof(double));

    for (int i = 0; i < (local_rows + 2) * COLS; i++) {
        curr[i] = 20.0;
        next[i] = 20.0;
    }

    int prev_rank = (rank > 0) ? rank - 1 : MPI_PROC_NULL;
    int next_rank = (rank < num_procs - 1) ? rank + 1 : MPI_PROC_NULL;

    MPI_Barrier(MPI_COMM_WORLD);
    start_time = MPI_Wtime();

    for (int iter = 0; iter < ITERATIONS; iter++) {
        // Troca contínua de bordas com vizinhos imediatos (Halo Exchange)
        MPI_Sendrecv(&curr[1 * COLS], COLS, MPI_DOUBLE, prev_rank, 0,
                     &curr[0 * COLS], COLS, MPI_DOUBLE, prev_rank, 1,
                     MPI_COMM_WORLD, MPI_STATUS_IGNORE);

        MPI_Sendrecv(&curr[local_rows * COLS], COLS, MPI_DOUBLE, next_rank, 1,
                     &curr[(local_rows + 1) * COLS], COLS, MPI_DOUBLE, next_rank, 0,
                     MPI_COMM_WORLD, MPI_STATUS_IGNORE);

        // Atualização dos pontos térmicos pelo estêncil de 5 pontos (média dos 4 vizinhos)
        for (int i = 1; i <= local_rows; i++) {
            for (int j = 1; j < COLS - 1; j++) {
                next[i * COLS + j] = 0.25 * (
                    curr[(i - 1) * COLS + j] +
                    curr[(i + 1) * COLS + j] +
                    curr[i * COLS + (j - 1)] +
                    curr[i * COLS + (j + 1)]
                );
            }
        }

        // Alterna ponteiros
        double *tmp = curr;
        curr = next;
        next = tmp;
    }

    MPI_Barrier(MPI_COMM_WORLD);
    end_time = MPI_Wtime();

    if (rank == 0) {
        double elapsed = end_time - start_time;
        printf("RESULTADO_NETWORK_BOUND,processos=%d,linhas=%d,colunas=%d,iteracoes=%d,tempo_segundos=%.4f\n",
               num_procs, ROWS, COLS, ITERATIONS, elapsed);
    }

    free(curr);
    free(next);
    MPI_Finalize();
    return 0;
}

