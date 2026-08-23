import os

bind = f"0.0.0.0:{os.getenv('PORT', '5000')}"
workers = int(os.getenv("WEB_CONCURRENCY", "2"))
threads = int(os.getenv("WEB_THREADS", "4"))
worker_class = "gthread"
timeout = int(os.getenv("WORKER_TIMEOUT", "150"))
graceful_timeout = 30
accesslog = "-"
errorlog = "-"
