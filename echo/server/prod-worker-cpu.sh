#!/bin/bash
dramatiq --queues cpu --processes 8 --threads 1 dembrane.tasks
