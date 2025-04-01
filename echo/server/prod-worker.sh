#!/bin/sh
echo "Starting worker"

POD_HOSTNAME=$(hostname)
celery -A dembrane.tasks worker -l INFO -n worker.${POD_HOSTNAME} -Q normal