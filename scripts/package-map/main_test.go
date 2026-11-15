package main

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/paralin/modlock/source2/resource"
	"github.com/paralin/modlock/source2/vpk"
)

func compiledResource(names ...string) []byte {
	data := make([]byte, 8+16*len(names))
	binary.LittleEndian.PutUint32(data, 8)
	binary.LittleEndian.PutUint32(data[4:], uint32(len(names)))
	for i, name := range names {
		field := 8 + i*16 + 8
		binary.LittleEndian.PutUint64(data[field:], uint64(len(data)-field))
		data = append(data, name...)
		data = append(data, 0)
	}
	result, _ := resource.Write(1, []resource.Block{{Tag: "RERL", Data: data}})
	return result
}

type fixture struct {
	t   *testing.T
	dir string
}

func newFixture(t *testing.T) fixture {
	return fixture{t: t, dir: t.TempDir()}
}

func (f fixture) path(name string) string { return filepath.Join(f.dir, name) }

func (f fixture) write(name string, data []byte) {
	f.t.Helper()
	path := f.path(name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		f.t.Fatal(err)
	}
}

func (f fixture) asset(name string, compiled bool, references ...string) {
	f.write("authored/"+name, []byte("authored asset"))
	if compiled {
		f.write("compiled/"+name+"_c", compiledResource(references...))
	}
}

func (f fixture) archive(directory, name string) string {
	f.t.Helper()
	output, err := os.Create(f.path(name))
	if err != nil {
		f.t.Fatal(err)
	}
	if err := vpk.Write(output, os.DirFS(f.path(directory))); err != nil {
		f.t.Fatal(err)
	}
	if err := output.Close(); err != nil {
		f.t.Fatal(err)
	}
	return f.path(name)
}

func (f fixture) names(path string) []string {
	f.t.Helper()
	archive, err := vpk.OpenArchive(path)
	if err != nil {
		f.t.Fatal(err)
	}
	return archive.Names()
}

func TestMapCarriesOriginalPathsAndTransitiveDependencies(t *testing.T) {
	f := newFixture(t)
	f.write("map/maps/arena/world.vwrld_c", compiledResource("materials/arena/floor.vmat", "particles/arena/flame.vpcf", "models/native/building.vmdl"))
	local := map[string][]byte{
		"materials/arena/floor.vmat_c":       compiledResource("materials/arena/floor_color.vtex"),
		"materials/arena/floor_color.vtex_c": compiledResource(),
		"particles/arena/flame.vpcf_c":       compiledResource("particles/arena/smoke.vpcf"),
		"particles/arena/smoke.vpcf_c":       compiledResource("particles/arena/flame.vpcf"),
	}
	verified := map[string]string{}
	for name, data := range local {
		f.write("compiled/"+name, data)
		verified[name] = "verified-by-caller"
	}
	input := f.archive("map", "input.vpk")
	output := f.path("output.vpk")
	from := sources{compiled: f.path("compiled"), authored: f.path("authored"), verified: verified}
	if err := pack(input, from, output); err != nil {
		t.Fatal(err)
	}
	archive, err := vpk.OpenArchive(output)
	if err != nil {
		t.Fatal(err)
	}
	if len(archive.Names()) != 5 {
		t.Fatalf("expected world plus four dependencies, got %v", archive.Names())
	}
	for name := range local {
		if _, err := archive.ReadFile(name); err != nil {
			t.Fatalf("original path missing: %s: %v", name, err)
		}
	}
	if _, ok := archive.Size("models/native/building.vmdl_c"); ok {
		t.Fatal("copied stock game asset")
	}
	delete(verified, "materials/arena/floor.vmat_c")
	if err := pack(input, from, output); err == nil || !strings.Contains(err.Error(), "unverified local resource materials/arena/floor.vmat_c") {
		t.Fatalf("accepted unverified local material: %v", err)
	}
}

func TestRecordReadsTheCompiledObject(t *testing.T) {
	f := newFixture(t)
	record, _ := json.Marshal(map[string]any{"map": "arena", "compiled": map[string]string{"materials/a.vmat_c": "digest"}})
	f.write("stamp.json", record)
	verified, err := readRecord(f.path("stamp.json"))
	if err != nil || len(verified) != 1 || verified["materials/a.vmat_c"] != "digest" {
		t.Fatalf("read %v, %v", verified, err)
	}
}

func TestWithoutRecordEveryCompiledReferenceIsPacked(t *testing.T) {
	f := newFixture(t)
	f.asset("models/mode/statue.vmdl", true, "materials/mode/amber.vmat", "materials/mode/blue.vmat")
	f.asset("materials/mode/amber.vmat", true, "materials/mode/amber.vtex")
	f.asset("materials/mode/blue.vmat", true)
	f.asset("materials/mode/amber.vtex", true)
	f.asset("particles/environment/fire.vpcf", true, "particles/environment/embers.vpcf")
	f.asset("particles/environment/embers.vpcf", true)
	f.asset("particles/environment/unused_experiment.vpcf", true)
	world := compiledResource("models/mode/statue.vmdl", "materials/stock/stone.vmat")
	f.write("map/maps/arena/world.vwrld_c", world)
	f.write("map/maps/arena.vmap_c", compiledResource("maps/arena/world.vwrld", "particles/environment/fire.vpcf"))
	output := f.path("output.vpk")
	from := sources{compiled: f.path("compiled"), authored: f.path("authored")}
	if err := pack(f.archive("map", "input.vpk"), from, output); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"maps/arena.vmap_c", "maps/arena/world.vwrld_c",
		"materials/mode/amber.vmat_c", "materials/mode/amber.vtex_c", "materials/mode/blue.vmat_c",
		"models/mode/statue.vmdl_c",
		"particles/environment/embers.vpcf_c", "particles/environment/fire.vpcf_c",
	}
	if got := f.names(output); !slices.Equal(got, want) {
		t.Fatalf("packed %v, want %v", got, want)
	}
	archive, _ := vpk.OpenArchive(output)
	if data, _ := archive.ReadFile("maps/arena/world.vwrld_c"); string(data) != string(world) {
		t.Fatal("the map's own entry changed")
	}

	count, err := check(output, from, []string{"maps/arena/world.vwrld_c"})
	if err != nil || count != len(want) {
		t.Fatalf("check counted %d, %v", count, err)
	}
}

func TestMissingLocalResourceStopsPacking(t *testing.T) {
	for _, test := range []struct {
		name     string
		setup    func(f fixture)
		prefixes []string
	}{
		{"an authored map asset without its compile", func(f fixture) {
			f.asset("particles/weather/snow.vpcf", false)
			f.write("map/maps/arena.vmap_c", compiledResource("particles/weather/snow.vpcf"))
		}, nil},
		{"an authored child without its compile", func(f fixture) {
			f.asset("particles/environment/fire.vpcf", true, "particles/environment/embers.vpcf")
			f.asset("particles/environment/embers.vpcf", false)
			f.write("map/maps/arena.vmap_c", compiledResource("particles/environment/fire.vpcf"))
		}, nil},
		{"a resource under the mode's own prefix", func(f fixture) {
			f.write("map/maps/arena.vmap_c", compiledResource("models/mode/gone.vmdl"))
		}, []string{"models/mode/"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newFixture(t)
			test.setup(f)
			from := sources{compiled: f.path("compiled"), authored: f.path("authored"), prefixes: test.prefixes}
			if err := pack(f.archive("map", "input.vpk"), from, f.path("output.vpk")); err == nil || !strings.Contains(err.Error(), "was not compiled") {
				t.Fatalf("packed a map without its local resource: %v", err)
			}
		})
	}
}

func TestCheckRefusesAMapWithoutItsLocalResources(t *testing.T) {
	f := newFixture(t)
	f.asset("materials/mode/floor.vmat", true)
	f.write("map/maps/arena/world.vwrld_c", compiledResource("materials/mode/floor.vmat", "materials/stock/stone.vmat"))
	input := f.archive("map", "input.vpk")

	if count, err := check(input, sources{}, nil); err != nil || count != 1 {
		t.Fatalf("check counted %d, %v", count, err)
	}
	if _, err := check(input, sources{}, []string{"maps/other/world.vwrld_c"}); err == nil {
		t.Fatal("accepted a map without its required world")
	}
	for _, from := range []sources{
		{compiled: f.path("compiled")},
		{authored: f.path("authored")},
		{prefixes: []string{"materials/mode/"}},
	} {
		if _, err := check(input, from, nil); err == nil || !strings.Contains(err.Error(), "does not carry") {
			t.Fatalf("accepted a map missing its material with %+v: %v", from, err)
		}
	}
}

func TestUnsafeReferencesFail(t *testing.T) {
	f := newFixture(t)
	f.write("map/maps/world.vwrld_c", compiledResource("../../outside.vmat"))
	if err := pack(f.archive("map", "input.vpk"), sources{compiled: f.path("compiled")}, f.path("output.vpk")); err == nil {
		t.Fatal("accepted a reference outside the compiled root")
	}
}

func TestMalformedReferencesFail(t *testing.T) {
	data := compiledResource("materials/arena/floor.vmat")
	blocks, _ := resource.Read(data)
	refs, _ := resource.Find(blocks, "RERL")
	binary.LittleEndian.PutUint64(refs[16:], uint64(len(data)*2))
	if _, err := references(data); err == nil {
		t.Fatal("accepted reference outside resource")
	}
}

func TestCommandLine(t *testing.T) {
	f := newFixture(t)
	f.write("map/maps/arena/world.vwrld_c", compiledResource())
	input := f.archive("map", "input.vpk")
	for _, arguments := range [][]string{
		nil,
		{"unpack", input},
		{"pack", input},
		{"pack", "-compiled", f.path("compiled"), "-record", f.path("missing.json"), input, f.path("output.vpk")},
		{"check"},
	} {
		if err := run(arguments); err == nil {
			t.Fatalf("accepted %v", arguments)
		}
	}
	if err := run([]string{"pack", "-compiled", f.path("compiled"), "-local", "materials/mode/", input, f.path("output.vpk")}); err != nil {
		t.Fatal(err)
	}
}
