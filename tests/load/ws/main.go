package main

import (
	"fmt"
	"os"
)

func main() {
	opts, err := parseOptions()
	if err == nil {
		err = execute(opts)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
