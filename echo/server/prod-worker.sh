#!/bin/bash
dramatiq-gevent --queues network --processes 3 --threads 50 dembrane.tasks
