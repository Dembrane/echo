#!/bin/bash
dramatiq-gevent --queues network --processes 1 --threads 2 dembrane.tasks