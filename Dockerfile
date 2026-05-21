FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libopenmpi-dev \
    openmpi-bin \
    openssh-server \
    sudo \
    git \
    curl \
    wget \
    iputils-ping \
    nano \
    vim \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 1000 aluno && \
    useradd -u 1000 -g 1000 -m -s /bin/bash aluno && \
    usermod -aG sudo aluno && \
    echo "aluno ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

RUN sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config && \
    sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config && \
    sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config

RUN mkdir -p /home/aluno/.ssh && \
    chmod 700 /home/aluno/.ssh && \
    chown -R aluno:aluno /home/aluno/.ssh

RUN mkdir -p /var/run/sshd && chmod 0755 /var/run/sshd

USER aluno
WORKDIR /home/aluno

EXPOSE 22

CMD ["/bin/bash", "-c", "sudo /usr/sbin/sshd -D"]