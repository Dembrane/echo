#!/usr/bin/env bash

dramatiq-gevent --queues network --processes 2 --threads 1 dembrane.tasks