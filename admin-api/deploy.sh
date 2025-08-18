#!/bin/bash
set -e

echo "Installing dependencies..."
npm ci

echo "Starting admin-api service..."
npm start
