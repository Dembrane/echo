#!/bin/bash
dramatiq --queues cpu --processes 2 --threads 4 dembrane.tasks
