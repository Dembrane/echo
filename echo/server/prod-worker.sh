#!/bin/bash
dramatiq-gevent --queues network --processes 2 --threads 50 dembrane.tasks
