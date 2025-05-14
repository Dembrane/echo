#!/bin/bash
dramatiq-gevent --queues network --processes 4 --threads 50 dembrane.tasks
