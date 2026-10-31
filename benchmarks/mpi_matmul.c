#include <stdio.h>
#include <stdlib.h>
#include <mpi.h>

#define N 2800  // Dimensao das matrizes quadradas N x N (ajustado para ~12s em np=1)

void init_matrix(double *mat, int size, double val) {
    for (int i = 0; i < size * size; i++) {
        mat[i] = val;
    }
}

int main(int argc, char **argv) {
    int rank, num_procs;
    double start_time, end_time;

    MPI_Init(&argc, &argv);
    MPI_Comm_rank(MPI_COMM_WORLD, &rank);
    MPI_Comm_size(MPI_COMM_WORLD, &num_procs);

    if (N % num_procs != 0) {
        if (rank == 0) {
            printf("Erro: N (%d) deve ser divisivel pelo numero de processos (%d)\n", N, num_procs);
        }
        MPI_Finalize();
        return 1;
    }

    int rows_per_proc = N / num_procs;

    double *A = NULL;
    double *B = (double *)malloc(N * N * sizeof(double));
    double *C = NULL;
    double *sub_A = (double *)malloc(rows_per_proc * N * sizeof(double));
    double *sub_C = (double *)calloc(rows_per_proc * N, sizeof(double));

    if (rank == 0) {
        A = (double *)malloc(N * N * sizeof(double));
        C = (double *)malloc(N * N * sizeof(double));
        init_matrix(A, N, 1.5);
        init_matrix(B, N, 2.0);
    }

    MPI_Barrier(MPI_COMM_WORLD);
    start_time = MPI_Wtime();

    // Broadcast da matriz B completa para todos os processos
    MPI_Bcast(B, N * N, MPI_DOUBLE, 0, MPI_COMM_WORLD);

    // Distribui fatias da matriz A para cada processo
    MPI_Scatter(A, rows_per_proc * N, MPI_DOUBLE,
                sub_A, rows_per_proc * N, MPI_DOUBLE,
                0, MPI_COMM_WORLD);

    // Computação aritmética intensiva O(N^3)
    for (int i = 0; i < rows_per_proc; i++) {
        for (int k = 0; k < N; k++) {
            for (int j = 0; j < N; j++) {
                sub_C[i * N + j] += sub_A[i * N + k] * B[k * N + j];
            }
        }
    }

    // Coleta as fatias computadas de volta para o Master (rank 0)
    MPI_Gather(sub_C, rows_per_proc * N, MPI_DOUBLE,
               C, rows_per_proc * N, MPI_DOUBLE,
               0, MPI_COMM_WORLD);

    MPI_Barrier(MPI_COMM_WORLD);
    end_time = MPI_Wtime();

    if (rank == 0) {
        double elapsed = end_time - start_time;
        printf("RESULTADO_CPU_BOUND,processos=%d,dimensao=%d,tempo_segundos=%.4f\n",
               num_procs, N, elapsed);
        free(A);
        free(C);
    }

    free(B);
    free(sub_A);
    free(sub_C);

    MPI_Finalize();
    return 0;
}

