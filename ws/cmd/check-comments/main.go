package main

import (
	"fmt"
	"go/parser"
	"go/token"
	"io"
	"io/fs"
	"os"
	"path"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: check-comments <repository-root>")
		os.Exit(2)
	}
	if !checkRepository(os.DirFS(os.Args[1]), os.Stderr) {
		os.Exit(1)
	}
}

func checkRepository(repository fs.FS, diagnostics io.Writer) bool {
	clean := true
	for _, module := range []string{"ws", "tests/load/ws"} {
		err := fs.WalkDir(repository, module, func(name string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() && name == "ws/internal/generated" {
				return fs.SkipDir
			}
			if entry.IsDir() || path.Ext(name) != ".go" {
				return nil
			}
			source, err := fs.ReadFile(repository, name)
			if err != nil {
				return err
			}
			findings, err := findComments(name, source)
			if err != nil {
				fmt.Fprintln(diagnostics, err)
				clean = false
			}
			for _, position := range findings {
				fmt.Fprintf(diagnostics, "%s: source comment is not an allowed Go directive\n", position)
				clean = false
			}
			return nil
		})
		if err != nil {
			fmt.Fprintln(diagnostics, err)
			clean = false
		}
	}
	return clean
}

func findComments(name string, source []byte) ([]token.Position, error) {
	positions := token.NewFileSet()
	file, err := parser.ParseFile(positions, name, source, parser.ParseComments|parser.SkipObjectResolution)
	if err != nil {
		return nil, err
	}
	var findings []token.Position
	goFile := positions.File(file.Pos())
	policy := directivePolicy{file: file, positions: goFile, source: source}
	for _, group := range file.Comments {
		for _, comment := range group.List {
			if !policy.allows(group, comment) {
				findings = append(findings, goFile.PositionFor(comment.Pos(), false))
			}
		}
	}
	return findings, nil
}
