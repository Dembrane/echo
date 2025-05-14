#!/bin/bash
dramatiq --queues cpu --processes 4 --threads 4 dembrane.tasks
