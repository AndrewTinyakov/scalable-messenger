package main

import (
	"bytes"
	"go/ast"
	"go/build/constraint"
	"go/token"
	"io/fs"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

var debugAssignment = regexp.MustCompile(`^[a-z][a-z0-9]*=[^\s,=]+$`)

type directivePolicy struct {
	file      *ast.File
	positions *token.File
	source    []byte
	buildSeen bool
}

func (p *directivePolicy) allows(group *ast.CommentGroup, comment *ast.Comment) bool {
	directive, ok := ast.ParseDirective(comment.Pos(), comment.Text)
	if !ok || directive.Tool != "go" {
		return false
	}
	offset := p.positions.Offset(comment.Pos())
	lineStart := bytes.LastIndexByte(p.source[:offset], '\n') + 1
	indent := p.source[lineStart:offset]
	if len(bytes.Trim(indent, " \t")) != 0 {
		return false
	}
	spaceAfterName := strings.HasPrefix(comment.Text, "//go:"+directive.Name+" ")
	header := comment.Pos() < p.file.Package
	switch directive.Name {
	case "build":
		if !header || p.buildSeen {
			return false
		}
		p.buildSeen = true
		_, err := constraint.Parse(comment.Text)
		return err == nil && p.file.Doc != group
	case "generate":
		args := strings.TrimPrefix(comment.Text, "//go:generate")
		return len(indent) == 0 && bytes.IndexByte(p.source[offset:], '\n') >= 0 && validGenerate(args)
	case "debug":
		mainOrTest := p.file.Name.Name == "main" || strings.HasSuffix(p.positions.Name(), "_test.go")
		return header && mainOrTest && debugAssignment.MatchString(directive.Args)
	case "linkname":
		args := strings.Fields(directive.Args)
		return spaceAfterName && len(args) >= 1 && len(args) <= 2 && p.imports("unsafe") && p.hasLinknameTarget(args[0], comment.Pos())
	}
	for _, decl := range p.file.Decls {
		switch decl := decl.(type) {
		case *ast.FuncDecl:
			if decl.Doc == group {
				return allowsFunctionDirective(directive, spaceAfterName, decl)
			}
		case *ast.GenDecl:
			for _, spec := range decl.Specs {
				switch spec := spec.(type) {
				case *ast.ValueSpec:
					if spec.Doc == group || (decl.Doc == group && !decl.Lparen.IsValid()) {
						return p.allowsValueDirective(directive, spaceAfterName, decl.Tok, spec)
					}
				case *ast.TypeSpec:
					if spec.Doc == group || (decl.Doc == group && !decl.Lparen.IsValid()) {
						return directive.Name == "fix" && directive.Args == "inline" && spec.Assign.IsValid()
					}
				}
			}
		}
	}
	return false
}

func validGenerate(args string) bool {
	if !strings.HasPrefix(args, " ") && !strings.HasPrefix(args, "\t") {
		return false
	}
	var words []string
	for args = strings.TrimLeft(args, " \t"); args != ""; args = strings.TrimLeft(args, " \t") {
		if args[0] == '"' {
			quoted, err := strconv.QuotedPrefix(args)
			if err != nil {
				return false
			}
			word, _ := strconv.Unquote(quoted)
			words = append(words, word)
			args = args[len(quoted):]
			if args != "" && args[0] != ' ' && args[0] != '\t' {
				return false
			}
			continue
		}
		end := strings.IndexAny(args, " \t")
		if end < 0 {
			end = len(args)
		}
		words = append(words, args[:end])
		args = args[end:]
	}
	return len(words) > 0 && words[0] != "" && (words[0] != "-command" || len(words) >= 3)
}

func allowsFunctionDirective(d ast.Directive, spaceAfterName bool, decl *ast.FuncDecl) bool {
	switch d.Name {
	case "noescape":
		return d.Args == "" && decl.Body == nil
	case "noinline", "nosplit", "norace", "nocheckptr", "uintptrescapes", "registerparams", "nointerface":
		return d.Args == ""
	case "wasmimport":
		return spaceAfterName && len(strings.Fields(d.Args)) == 2 && decl.Body == nil && decl.Recv == nil
	case "wasmexport":
		return spaceAfterName && len(strings.Fields(d.Args)) == 1 && decl.Body != nil && decl.Recv == nil
	case "fix":
		return d.Args == "inline" && decl.Body != nil
	default:
		return false
	}
}

func (p *directivePolicy) allowsValueDirective(d ast.Directive, spaceAfterName bool, kind token.Token, spec *ast.ValueSpec) bool {
	switch d.Name {
	case "embed":
		if !spaceAfterName || kind != token.VAR || len(spec.Names) != 1 || spec.Type == nil || len(spec.Values) != 0 || !p.imports("embed") {
			return false
		}
		args, err := d.ParseArgs()
		return err == nil && len(args) > 0 && !slices.ContainsFunc(args, func(arg ast.DirectiveArg) bool {
			pattern := strings.TrimPrefix(arg.Arg, "all:")
			_, err := path.Match(pattern, "")
			return pattern == "." || !fs.ValidPath(pattern) || err != nil
		})
	case "fix":
		return d.Args == "inline" && kind == token.CONST && len(spec.Names) == 1 && len(spec.Values) == 1
	default:
		return false
	}
}

func (p *directivePolicy) imports(name string) bool {
	for _, spec := range p.file.Imports {
		if imported, err := strconv.Unquote(spec.Path.Value); err == nil && imported == name {
			return true
		}
	}
	return false
}

func (p *directivePolicy) hasLinknameTarget(name string, pos token.Pos) bool {
	for _, decl := range p.file.Decls {
		switch decl := decl.(type) {
		case *ast.FuncDecl:
			if decl.Body != nil && decl.Body.Pos() < pos && pos < decl.Body.End() {
				return false
			}
		case *ast.GenDecl:
			if decl.Pos() < pos && pos < decl.End() {
				return false
			}
		}
	}
	for _, decl := range p.file.Decls {
		switch decl := decl.(type) {
		case *ast.FuncDecl:
			if decl.Recv == nil && decl.Name.Name == name {
				return true
			}
		case *ast.GenDecl:
			if decl.Tok == token.VAR {
				for _, spec := range decl.Specs {
					for _, ident := range spec.(*ast.ValueSpec).Names {
						if ident.Name == name {
							return true
						}
					}
				}
			}
		}
	}
	return false
}
