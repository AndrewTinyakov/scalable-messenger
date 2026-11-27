package main

import (
	"bytes"
	"fmt"
	"slices"
	"strings"
	"testing"
	"testing/fstest"
)

func TestFindComments(t *testing.T) {
	for _, test := range []struct {
		name   string
		source string
		want   []string
	}{
		{
			name: "package and function docs",
			source: `// Package demo.
package demo

// F returns.
func F() {}`,
			want: []string{"1:1", "4:1"},
		},
		{
			name: "trailing and block comments",
			source: `package demo
var x = 1 // trailing
/* block
across lines */
var y = /* inline */ 2`,
			want: []string{"2:11", "3:1", "5:9"},
		},
		{
			name: "quoted comment markers",
			source: "package demo\n" +
				"const raw = `\n" +
				"// prose\n" +
				"/* block */\n" +
				"//go:generate false\n" +
				"`\n" +
				"const address = \"https://example.com\"",
		},
		{
			name: "only recognized directives",
			source: `package demo
//go:noinline
// prose
func f() {}
//go:unknown
//nolint:revive
// Code generated. DO NOT EDIT.
`,
			want: []string{"3:1", "5:1", "6:1", "7:1"},
		},
		{
			name: "build expression",
			source: `//go:build linux && !arm64

package demo`,
		},
		{
			name: "malformed build expression",
			source: `//go:build linux &&

package demo`,
			want: []string{"1:1"},
		},
		{
			name: "duplicate build expression",
			source: `//go:build linux
//go:build arm64

package demo`,
			want: []string{"2:1"},
		},
		{
			name: "build attached to package",
			source: `//go:build linux
package demo`,
			want: []string{"1:1"},
		},
		{
			name: "build below package",
			source: `package demo
//go:build linux
`,
			want: []string{"2:1"},
		},
		{
			name: "generate command and alias",
			source: `package demo
//go:generate	-command tool go run ./tool
//go:generate tool "two words"
`,
		},
		{
			name: "misplaced and malformed generate",
			source: `package demo
  //go:generate echo ok
//go:generate
//go:generate echo "unfinished
//go:generate -command tool
var x = 1 //go:generate echo ok
`,
			want: []string{"2:3", "3:1", "4:1", "5:1", "6:11"},
		},
		{
			name: "embed on var and grouped var",
			source: `package demo
import _ "embed"
//go:embed "file name.txt"
var data string
var (
	//go:embed notes/*.md
	files []byte
)
`,
		},
		{
			name: "invalid embed syntax or target",
			source: `package demo
import _ "embed"
//go:embed "file"oops
var data string
//go:embed foo
const wrong = 0
//go:embed foo
var initialized = ""
`,
			want: []string{"3:1", "5:1", "7:1"},
		},
		{
			name: "embed requires a package var and import",
			source: `package demo
//go:embed foo
var data string
func f() {
//go:embed bar
var local string
_ = local
}
`,
			want: []string{"2:1", "5:1"},
		},
		{
			name: "compiler directives on functions",
			source: `package demo
//go:noescape
func f(*int)
//go:nosplit
func g() {}
//go:wasmimport env fn
func wasm()
`,
		},
		{
			name: "compiler directive position and arguments",
			source: `package demo
//go:noescape
func f() {}
//go:noinline explanation
func g() {
//go:nosplit
var x int
}
//go:nocheckptr

func h() {}
`,
			want: []string{"2:1", "4:1", "6:1", "9:1"},
		},
		{
			name: "debug inside main header",
			source: `//go:debug panicnil=1

package main
`,
		},
		{
			name: "debug after package",
			source: `package main
//go:debug panicnil=1
`,
			want: []string{"2:1"},
		},
		{
			name: "linkname with target and unsafe import",
			source: `package demo
import _ "unsafe"
//go:linkname f other.f
func f()
`,
		},
		{
			name: "linkname without unsafe import",
			source: `package demo
//go:linkname f other.f
func f()
`,
			want: []string{"2:1"},
		},
		{
			name: "fix inline on alias or function",
			source: `package demo
//go:fix inline
type Alias = int
//go:fix inline
func f() int { return g() }
func g() int { return 0 }`,
		},
		{
			name: "spaced and block directives",
			source: `package demo
// go:noinline
/*go:noinline*/
func f() {}
`,
			want: []string{"2:1", "3:1"},
		},
		{
			name: "line directives at the start of a line or inline as block comments",
			source: `//line C:\source files\input.go:10:2
package demo
//line :12
var x = /*line :30:20*/ 0
/*line another.go:50*/ var y = 0
`,
		},
		{
			name:   "line directive with CRLF",
			source: "package demo\r\n//line input.go:20\r\nvar x = 0\r\n",
		},
		{
			name: "line directive lookalikes and misplaced line directives",
			source: `package demo
 //line input.go:10
var x = 0 //line input.go:20
// line input.go:30
//line missing-colon
/*line missing-colon*/
/*line	input.go:40*/
`,
			want: []string{"2:2", "3:11", "4:1", "5:1", "6:1", "7:1"},
		},
		{
			name: "physical source positions",
			source: `package demo
//line fake.go:50
// text
var x = 0
`,
			want: []string{"3:1"},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			findings, err := findComments("ws/example.go", []byte(test.source))
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, position := range findings {
				if position.Filename != "ws/example.go" {
					t.Errorf("filename = %s, want ws/example.go", position.Filename)
				}
				got = append(got, fmt.Sprintf("%d:%d", position.Line, position.Column))
			}
			if !slices.Equal(got, test.want) {
				t.Errorf("findings = %v, want %v", got, test.want)
			}
		})
	}
}

func TestMalformedLineDirectiveFails(t *testing.T) {
	for _, directive := range []string{
		"//line input.go:0",
		"//line input.go:1073741825",
		"/*line input.go:10:0*/",
		"/*line input.go: 10*/",
		"/*line input.go:18446744073709551615*/",
	} {
		findings, err := findComments("ws/example.go", []byte("package demo\n"+directive+"\nvar x = 0\n"))
		if err == nil && len(findings) != 1 {
			t.Errorf("accepted malformed line directive %q", directive)
		}
	}
}

func TestCheckRepositoryIncludesBothModulesAndPrunesOnlyGeneratedOutput(t *testing.T) {
	repository := fstest.MapFS{
		"ws/socket_windows.go":                 {Data: []byte("package example\n// production\n")},
		"ws/internal/generated/output.go":      {Data: []byte("unparseable generated output")},
		"ws/internal/other/generated/input.go": {Data: []byte("package example\n// handwritten\n")},
		"tests/load/ws/load_test.go":           {Data: []byte("package main\n// test\n")},
		"outside/other.go":                     {Data: []byte("outside both modules")},
	}
	var diagnostics bytes.Buffer
	if checkRepository(repository, &diagnostics) {
		t.Fatal("check passed with source comments")
	}
	lines := strings.Split(strings.TrimSpace(diagnostics.String()), "\n")
	want := []string{"ws/internal/other/generated/input.go:2:1:", "ws/socket_windows.go:2:1:", "tests/load/ws/load_test.go:2:1:"}
	if len(lines) != len(want) {
		t.Fatalf("diagnostics = %q", lines)
	}
	for i, prefix := range want {
		if !strings.HasPrefix(lines[i], prefix) {
			t.Errorf("diagnostic %d = %q, want prefix %q", i, lines[i], prefix)
		}
	}
}

func TestCheckRepositoryFailsOnParseErrors(t *testing.T) {
	repository := fstest.MapFS{
		"ws/broken.go":          {Data: []byte("not Go source")},
		"tests/load/ws/main.go": {Data: []byte("package main\n")},
	}
	var diagnostics bytes.Buffer
	if checkRepository(repository, &diagnostics) || !strings.Contains(diagnostics.String(), "ws/broken.go:1:1:") {
		t.Fatalf("expected a parse error, got %q", diagnostics.String())
	}
}
