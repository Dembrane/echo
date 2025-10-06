#!/usr/bin/env bash

dramatiq --queues cpu --processes 2 --threads 1 dembrane.tasks