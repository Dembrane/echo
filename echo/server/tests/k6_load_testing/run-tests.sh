#!/bin/bash

# K6 Load Testing Runner for RunPod API (Unified Script)
# Usage: ./run-tests.sh [test-type] [options]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
TEST_TYPE="smoke"
RESULTS_DIR="./results"
DOCKER_IMAGE="grafana/k6:latest"
K6_SCRIPT="scripts/k6_runpod_transcribe.js"

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to show usage
show_usage() {
    echo "Usage: $0 [test-type] [options]"
    echo ""
    echo "Test Types:"
    echo "  smoke     - Basic functionality test (default)"
    echo "  load      - Standard load test"
    echo "  stress    - Stress test to find breaking points"
    echo "  spike     - Spike test for sudden load increases"
    echo "  all       - Run all test types sequentially"
    echo ""
    echo "Options:"
    echo "  -h, --help     Show this help message"
    echo "  -c, --clean    Clean results directory before running"
    echo "  -v, --verbose  Verbose output"
    echo ""
    echo "Examples:"
    echo "  $0 smoke"
    echo "  $0 load --clean"
    echo "  $0 stress -v"
    echo "  $0 all"
}

# Function to check prerequisites
check_prerequisites() {
    print_status "Checking prerequisites..."
    
    # Check if Docker is installed and running
    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed. Please install Docker first."
        exit 1
    fi
    
    if ! docker info &> /dev/null; then
        print_error "Docker is not running. Please start Docker first."
        exit 1
    fi
    
    # Check if .env file exists
    if [ ! -f ".env" ]; then
        print_error ".env file not found. Please create it from env.example"
        print_status "Run: cp env.example .env"
        print_status "Then edit .env with your RunPod API key and config."
        exit 1
    fi
    
    # Check if API key is set
    if ! grep -q "RUNPOD_API_KEY=.*[^[:space:]]" .env; then
        print_error "RUNPOD_API_KEY is not set in .env file"
        exit 1
    fi
    print_success "Prerequisites check passed"
}

# Function to create results directory
setup_results_dir() {
    if [ "$CLEAN_RESULTS" = true ]; then
        print_status "Cleaning results directory..."
        rm -rf "$RESULTS_DIR"
    fi
    
    mkdir -p "$RESULTS_DIR"
    print_status "Results will be saved to: $RESULTS_DIR"
}

# Function to run the test
run_test() {
    print_status "Running $TEST_TYPE test..."
    print_status "Script: $K6_SCRIPT"

    # Compose docker run command
    local docker_cmd="docker run --rm"
    docker_cmd="$docker_cmd -v $(pwd)/scripts:/scripts"
    docker_cmd="$docker_cmd -v $(pwd)/$RESULTS_DIR:/results"
    docker_cmd="$docker_cmd --env-file .env"
    docker_cmd="$docker_cmd -e TEST_TYPE=$TEST_TYPE"
    if [ "$VERBOSE" = true ]; then
        docker_cmd="$docker_cmd -e K6_LOG_LEVEL=debug"
    fi
    docker_cmd="$docker_cmd $DOCKER_IMAGE run"
    docker_cmd="$docker_cmd --out json=/results/${TEST_TYPE}-test-results.json"
    docker_cmd="$docker_cmd /$K6_SCRIPT"

    print_status "Executing: $docker_cmd"

    # Run the test
    if eval $docker_cmd; then
        print_success "$TEST_TYPE test completed successfully"
        print_status "Results saved to: $RESULTS_DIR/${TEST_TYPE}-test-results.json"
    else
        print_error "$TEST_TYPE test failed"
        exit 1
    fi
}

# Function to run all tests
run_all_tests() {
    local tests=("smoke" "load" "stress" "spike")
    print_status "Running all test types..."
    for test in "${tests[@]}"; do
        TEST_TYPE="$test"
        print_status "Starting $test test..."
        run_test
        print_success "$test test completed"
        echo ""
    done
    print_success "All tests completed!"
}

# Parse command line arguments
CLEAN_RESULTS=false
VERBOSE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        smoke|load|stress|spike)
            TEST_TYPE="$1"
            shift
            ;;
        all)
            TEST_TYPE="all"
            shift
            ;;
        -c|--clean)
            CLEAN_RESULTS=true
            shift
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
    done

# Main execution
main() {
    print_status "K6 Load Testing for RunPod API (Unified Script)"
    print_status "Test type: $TEST_TYPE"
    echo ""
    check_prerequisites
    setup_results_dir
    if [ "$TEST_TYPE" = "all" ]; then
        run_all_tests
    else
        run_test
    fi
    print_success "Testing completed!"
}

# Run main function
main 