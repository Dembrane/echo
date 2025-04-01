from kombu import Queue, Exchange  # type: ignore

enable_utc = True

worker_hijack_root_logger = False
worker_prefetch_multiplier = 1

task_queues = (
    Queue("normal", Exchange("normal"), routing_key="normal"),
    Queue("cpu", Exchange("cpu"), routing_key="cpu"),
)

task_default_queue = "normal"
task_default_exchange = "normal"
task_default_routing_key = "normal"

task_ignore_result = False

task_acks_late = True
task_reject_on_worker_lost = True

broker_connection_retry = True
broker_connection_retry_on_startup = True
broker_connection_max_retries = 5
broker_connection_timeout = 2

broker_transport_options = {
    "visibility_timeout": 1800,
    "socket_keepalive": True,
}
