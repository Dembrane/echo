#!/bin/bash
dramatiq --queues cpu --processes 4 --threads 6 dembrane.tasks
