#!/usr/bin/env bash

dramatiq-gevent --watch ./dembrane --queues network --processes 2 --threads 1 dembrane.tasks
