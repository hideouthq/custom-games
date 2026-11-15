// Command package-map runs from the runtime's checkout, whose module provides
// the VPK and resource codecs it imports.
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/paralin/modlock/source2/resource"
	"github.com/paralin/modlock/source2/vpk"
)

// references returns the resources a compiled resource names in its RERL
// block, each as the engine requests it: lower case, with forward slashes
// and the compiled "_c" suffix.
func references(data []byte) ([]string, error) {
	blocks, err := resource.Read(data)
	if err != nil {
		return nil, err
	}
	refs, ok := resource.Find(blocks, "RERL")
	if !ok {
		return nil, nil
	}
	if len(refs) < 8 {
		return nil, fmt.Errorf("truncated reference header")
	}
	start, count := int(binary.LittleEndian.Uint32(refs)), int(binary.LittleEndian.Uint32(refs[4:]))
	if start < 8 || start > len(refs) || count > (len(refs)-start)/16 {
		return nil, fmt.Errorf("truncated reference table")
	}
	var names []string
	for i := 0; i < count; i++ {
		field := start + i*16 + 8
		name := int64(field) + int64(binary.LittleEndian.Uint64(refs[field:]))
		if name < 0 || name >= int64(len(refs)) {
			return nil, fmt.Errorf("invalid reference offset")
		}
		end := bytes.IndexByte(refs[name:], 0)
		if end < 0 {
			return nil, fmt.Errorf("unterminated reference")
		}
		value := strings.ToLower(strings.ReplaceAll(string(refs[name:name+int64(end)]), "\\", "/"))
		if !fs.ValidPath(value) {
			return nil, fmt.Errorf("unsafe resource path %q", value)
		}
		if !strings.HasSuffix(value, "_c") {
			value += "_c"
		}
		names = append(names, value)
	}
	return names, nil
}

type sources struct {
	compiled, authored string
	verified           map[string]string
	prefixes           []string
}

func (s sources) local(name string) (bool, error) {
	for _, prefix := range s.prefixes {
		if strings.HasPrefix(name, prefix) {
			return true, nil
		}
	}
	for _, path := range []string{s.under(s.compiled, name), s.under(s.authored, strings.TrimSuffix(name, "_c"))} {
		if path == "" {
			continue
		}
		if _, err := os.Stat(path); err == nil {
			return true, nil
		} else if !os.IsNotExist(err) {
			return false, err
		}
	}
	return false, nil
}

func (s sources) packed(name string) (string, error) {
	compiled := s.under(s.compiled, name)
	if s.verified != nil {
		if _, ok := s.verified[name]; ok {
			return compiled, nil
		}
	} else if _, err := os.Stat(compiled); err == nil {
		return compiled, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	local, err := s.local(name)
	if err != nil || !local {
		return "", err
	}
	if s.verified != nil {
		return "", fmt.Errorf("unverified local resource %s; recompile", name)
	}
	return "", fmt.Errorf("local resource %s, which was not compiled; recompile", name)
}

func (s sources) under(root, name string) string {
	if root == "" {
		return ""
	}
	return filepath.Join(root, filepath.FromSlash(name))
}

func readRecord(path string) (map[string]string, error) {
	var record struct {
		Compiled map[string]string `json:"compiled"`
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &record); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if record.Compiled == nil {
		record.Compiled = map[string]string{}
	}
	return record.Compiled, nil
}

func pack(input string, from sources, output string) error {
	if from.compiled == "" {
		return fmt.Errorf("pack needs the compiled resource root")
	}
	archive, err := vpk.OpenArchive(input)
	if err != nil {
		return err
	}
	temporary, err := os.MkdirTemp(filepath.Dir(output), "map-resources-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	queue := archive.Names()
	files := make(map[string]string)
	taken := make(map[string]bool)
	for _, name := range queue {
		if !fs.ValidPath(name) {
			return fmt.Errorf("unsafe map entry %q", name)
		}
		taken[name] = true
	}
	original := len(queue)
	for i := 0; i < len(queue); i++ {
		name := queue[i]
		var contents []byte
		if i < original {
			contents, err = archive.ReadFile(name)
		} else {
			contents, err = os.ReadFile(files[name])
		}
		if err != nil {
			return err
		}
		destination := filepath.Join(temporary, name)
		if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(destination, contents, 0o644); err != nil {
			return err
		}
		if !strings.HasSuffix(name, "_c") {
			continue
		}
		dependencies, err := references(contents)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		for _, dependency := range dependencies {
			if taken[dependency] {
				continue
			}
			file, err := from.packed(dependency)
			if err != nil {
				return fmt.Errorf("%s requires %w", name, err)
			}
			if file != "" {
				taken[dependency] = true
				files[dependency] = file
				queue = append(queue, dependency)
			}
		}
	}
	file, err := os.Create(output)
	if err != nil {
		return err
	}
	err = vpk.Write(file, os.DirFS(temporary))
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	result, err := vpk.OpenArchive(output)
	if err != nil {
		return err
	}
	if len(result.Names()) != len(queue) {
		return fmt.Errorf("packed map entry count changed")
	}
	for _, name := range queue {
		actual, err := result.ReadFile(name)
		if err != nil {
			return err
		}
		expected, err := os.ReadFile(filepath.Join(temporary, name))
		if err != nil {
			return err
		}
		if !bytes.Equal(actual, expected) {
			return fmt.Errorf("packed resource changed: %s", name)
		}
	}
	fmt.Printf("Map package: %d original entries + %d local dependencies; all bytes verified\n", original, len(queue)-original)
	return nil
}

func check(path string, from sources, required []string) (int, error) {
	archive, err := vpk.OpenArchive(path)
	if err != nil {
		return 0, err
	}
	names := archive.Names()
	held := make(map[string]bool, len(names))
	for _, name := range names {
		if !fs.ValidPath(name) {
			return 0, fmt.Errorf("unsafe map entry %q", name)
		}
		held[name] = true
	}
	for _, name := range required {
		if !held[name] {
			return 0, fmt.Errorf("%s holds no %s", path, name)
		}
	}
	for _, name := range names {
		if !strings.HasSuffix(name, "_c") {
			continue
		}
		contents, err := archive.ReadFile(name)
		if err != nil {
			return 0, err
		}
		dependencies, err := references(contents)
		if err != nil {
			return 0, fmt.Errorf("%s: %w", name, err)
		}
		for _, dependency := range dependencies {
			if held[dependency] {
				continue
			}
			if local, err := from.local(dependency); err != nil {
				return 0, err
			} else if local {
				return 0, fmt.Errorf("%s requires %s, which the map does not carry; package it again", name, dependency)
			}
		}
	}
	return len(names), nil
}

type list []string

func (l *list) String() string     { return strings.Join(*l, ",") }
func (l *list) Set(v string) error { *l = append(*l, v); return nil }

func flags(set *flag.FlagSet, from *sources) {
	set.StringVar(&from.compiled, "compiled", "", "the mode's compiled resource `root`")
	set.StringVar(&from.authored, "authored", "", "the mode's authored source `root`; a resource authored there is local")
	set.Var((*list)(&from.prefixes), "local", "a path `prefix` only the mode's own resources use (repeatable)")
}

func run(arguments []string) error {
	if len(arguments) == 0 {
		return fmt.Errorf("name a command: pack or check")
	}
	var from sources
	set := flag.NewFlagSet(arguments[0], flag.ContinueOnError)
	flags(set, &from)
	switch arguments[0] {
	case "pack":
		record := set.String("record", "", "a build `record` whose \"compiled\" object names the only compiled resources to take")
		if err := set.Parse(arguments[1:]); err != nil {
			return err
		}
		if set.NArg() != 2 {
			return fmt.Errorf("pack takes the compiled map and the output: pack [flags] INPUT OUTPUT")
		}
		if *record != "" {
			verified, err := readRecord(*record)
			if err != nil {
				return err
			}
			from.verified = verified
		}
		return pack(set.Arg(0), from, set.Arg(1))
	case "check":
		var required list
		set.Var(&required, "require", "an entry `name` the map must hold (repeatable)")
		if err := set.Parse(arguments[1:]); err != nil {
			return err
		}
		if set.NArg() != 1 {
			return fmt.Errorf("check takes the map: check [flags] VPK")
		}
		count, err := check(set.Arg(0), from, required)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]int{"resources": count})
	}
	return fmt.Errorf("no command %q: pack or check", arguments[0])
}

func main() {
	log.SetFlags(0)
	if err := run(os.Args[1:]); err != nil {
		log.Fatal(err)
	}
}
