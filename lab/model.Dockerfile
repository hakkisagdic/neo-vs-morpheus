# A fine-tuned Laya checkpoint served on the CPU (training/serve_checkpoint.py), for hosts without
# a GPU. The checkpoint is mounted at /models.
FROM python:3.12-slim
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
 && pip install --no-cache-dir "laya[serve]==0.3.20"
WORKDIR /app
COPY training/serve_checkpoint.py training/serve_checkpoint.py
