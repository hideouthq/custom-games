"""Build the arena's models from the game's own assets.

Run with Blender, after exporting the source models as glTF with
Source2Viewer:

    blender -b --python scripts/models.py -- --exports <folder of exports>

It writes OBJ meshes, their collision and ModelDoc files into the addon's
models/pillars, and
scripts/arena-models.json, which records each model's path, bounds and placement. The
meshes keep the game's UVs and name the game's own materials; no Valve
texture or model is copied into the addon.

Ring pillar: the park statue base's cornice with its raised top cut off and
filled flat, over its body stretched 100 m down. Centre: the light guard
statue (the stock model, placed in the map) under a flat deck, on the
government column stretched into the void, with two bramble vines coiled
round the column and two dragon wings as fins. The column, deck, vines and
wings wear the statue's stone in its tintable form, tinted to match it.
"""
import argparse
import json
import math
from pathlib import Path
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[1]
LAYOUT = json.loads((ROOT / "scripts/arena.json").read_text())
ADDON = json.loads((ROOT / "project.json").read_text())["addon"]
MODELS = ROOT / "content/citadel_addons" / ADDON / "models/pillars"
RECORD = ROOT / "scripts/arena-models.json"

SOURCES = {
    "base": "models/park/park_props/park_statue_base_01",
    "guard": "models/props_statues/statue_light_guard_01",
    "column": "models/architecture/arch_gov/arch_gov_pillar",
    "vine": "models/abilities/ivy_bramble_model_fx",
    "dragon": "models/abilities/bookworm_dragon_model",
}
WALL = "materials/park/park_wall_01/park_wall_01.vmat"
STONE = "materials/stone/stone_tile_01/stone_tile_01_tintable.vmat"

UNIT = 0.0254
TO_GAME = Matrix.Rotation(math.pi / 2, 4, "Z") @ Matrix.Scale(1 / UNIT, 4)

BASE_TOP, FLAT_TOP, SPLIT = 1.0, 3.42, 2.3
GUARD_HEIGHT, GUARD_DECK = 13.21, 8.36
DECK_THICKNESS = 0.3
COLUMN_LENGTH = 130.0


def load(exports: Path, key: str, centre_floor: bool = True):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(exports / (SOURCES[key] + ".glb")))
    new = [item for item in bpy.data.objects if item not in before]
    meshes = [item for item in new if item.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for item in meshes:
        item.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    mesh = bpy.context.view_layer.objects.active
    for item in new:
        if item is not mesh and item.name in bpy.data.objects and item.type != "MESH":
            for child in item.children:
                child.parent = None
    mesh.parent = None
    mesh.modifiers.clear()
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for item in new:
        if item is not mesh and item.name in bpy.data.objects:
            bpy.data.objects.remove(item, do_unlink=True)
    shift = Vector((0, 0, 0))
    if centre_floor:
        points = [vertex.co for vertex in mesh.data.vertices]
        shift = Vector(((max(p.x for p in points) + min(p.x for p in points)) / 2,
                        (max(p.y for p in points) + min(p.y for p in points)) / 2,
                        min(p.z for p in points)))
        for vertex in mesh.data.vertices:
            vertex.co -= shift
    return mesh, shift


def cut(mesh, low: float, high: float) -> float:
    bm = bmesh.new()
    bm.from_mesh(mesh.data)
    uv = bm.loops.layers.uv.active
    top = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                                 plane_co=(0, 0, high), plane_no=(0, 0, 1), clear_outer=True)
    ring = [item.co for item in top["geom_cut"] if isinstance(item, bmesh.types.BMVert)]
    half = max(max(abs(point.x), abs(point.y)) for point in ring)
    face = bm.faces.new([bm.verts.new((x * half, y * half, high))
                         for x, y in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    face.normal_update()
    if face.normal.z < 0:
        face.normal_flip()
    if uv:
        for loop in face.loops:
            loop[uv].uv = (loop.vert.co.x / 2.0, loop.vert.co.y / 2.0)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                           plane_co=(0, 0, low), plane_no=(0, 0, 1), clear_inner=True)
    bm.to_mesh(mesh.data)
    bm.free()
    return half


def stretch(mesh, split: float, extra: float) -> None:
    bm = bmesh.new()
    bm.from_mesh(mesh.data)
    uv = bm.loops.layers.uv.active
    fixes = []
    for face in bm.faces:
        above = [loop for loop in face.loops if loop.vert.co.z > split]
        if not above or len(above) == len(face.loops) or uv is None:
            continue
        loops = face.loops
        origin, start = loops[0].vert.co.copy(), loops[0][uv].uv.copy()
        best = None
        for i in range(1, len(loops) - 1):
            for j in range(i + 1, len(loops)):
                e1, e2 = loops[i].vert.co - origin, loops[j].vert.co - origin
                area = e1.cross(e2).length
                if best is None or area > best[0]:
                    best = (area, e1, e2, loops[i][uv].uv - start, loops[j][uv].uv - start)
        area, e1, e2, d1, d2 = best
        if area < 1e-9:
            continue
        a11, a12, a22 = e1.dot(e1), e1.dot(e2), e2.dot(e2)
        det = a11 * a22 - a12 * a12
        slopes = []
        for axis in (0, 1):
            first = (d1[axis] * a22 - d2[axis] * a12) / det
            second = (d2[axis] * a11 - d1[axis] * a12) / det
            slopes.append(e1 * first + e2 * second)
        for loop in above:
            fixes.append((loop, slopes[0].z * extra, slopes[1].z * extra))
    for loop, du, dv in fixes:
        loop[uv].uv = (loop[uv].uv.x + du, loop[uv].uv.y + dv)
    for vertex in bm.verts:
        if vertex.co.z > split:
            vertex.co.z += extra
    bm.to_mesh(mesh.data)
    bm.free()


def scale_uvs(mesh, factor: float) -> None:
    layer = mesh.data.uv_layers.active
    if layer:
        for item in layer.data:
            item.uv = (item.uv.x * factor, item.uv.y * factor)


def baked(mesh):
    bpy.context.view_layer.update()
    evaluated = mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
    data = bpy.data.meshes.new_from_object(evaluated)
    data.transform(mesh.matrix_world)
    result = bpy.data.objects.new(mesh.name + "_baked", data)
    bpy.context.scene.collection.objects.link(result)
    return result


def coil(exports: Path, radius: float, top: float, bottom: float, pitch: float,
         phase: float, thickness: float):
    vine, _ = load(exports, "vine")
    height = max(vertex.co.z for vertex in vine.data.vertices)
    width = max(max(abs(vertex.co.x), abs(vertex.co.y)) for vertex in vine.data.vertices) * 2
    size = thickness / width
    for vertex in vine.data.vertices:
        vertex.co *= size
    turns = (top - bottom) / pitch
    length = turns * math.hypot(2 * math.pi * radius, pitch)
    array = vine.modifiers.new("Array", "ARRAY")
    array.relative_offset_displace = (0, 0, 1)
    array.count = math.ceil(length / (height * size)) + 1
    curve = bpy.data.curves.new("Helix", "CURVE")
    curve.dimensions = "3D"
    spline = curve.splines.new("POLY")
    steps = int(turns * 64) + 1
    spline.points.add(steps - 1)
    for index in range(steps):
        part = index / (steps - 1)
        angle = phase + 2 * math.pi * turns * part
        spline.points[index].co = (math.cos(angle) * radius, math.sin(angle) * radius,
                                   top - (top - bottom) * part, 1)
    path = bpy.data.objects.new("Helix", curve)
    bpy.context.scene.collection.objects.link(path)
    deform = vine.modifiers.new("Curve", "CURVE")
    deform.object = path
    deform.deform_axis = "POS_Z"
    coiled = baked(vine)

    bm = bmesh.new()
    bm.from_mesh(coiled.data)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                           plane_co=(0, 0, bottom), plane_no=(0, 0, 1), clear_inner=True)
    bm.to_mesh(coiled.data)
    bm.free()
    return coiled


def wing(exports: Path, root_x: float):
    dragon, _ = load(exports, "dragon", centre_floor=False)
    bm = bmesh.new()
    bm.from_mesh(dragon.data)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                           plane_co=(root_x, 0, 0), plane_no=(1, 0, 0), clear_inner=True)
    root = [vertex.co for vertex in bm.verts if vertex.co.x < root_x + .25]
    sides = [vertex.co.y for vertex in bm.verts]
    pivot = Vector((root_x, (min(sides) + max(sides)) / 2, sum(point.z for point in root) / len(root)))
    for vertex in bm.verts:
        vertex.co -= pivot
    bm.to_mesh(dragon.data)
    bm.free()
    return dragon


def block(low, high):
    bm = bmesh.new()
    corners = [bm.verts.new((x, y, z)) for z in (low[2], high[2])
               for x, y in ((low[0], low[1]), (high[0], low[1]), (high[0], high[1]), (low[0], high[1]))]
    for order in ((3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        bm.faces.new([corners[index] for index in order])
    uv = bm.loops.layers.uv.new("UVMap")
    for face in bm.faces:
        face.normal_update()
        flat = max(range(3), key=lambda axis: abs(face.normal[axis]))
        across, up = [axis for axis in range(3) if axis != flat]
        for loop in face.loops:
            loop[uv].uv = (loop.vert.co[across] / 2.0, loop.vert.co[up] / 2.0)
    data = bpy.data.meshes.new("block")
    bm.to_mesh(data)
    bm.free()
    part = bpy.data.objects.new("block", data)
    bpy.context.scene.collection.objects.link(part)
    return part


def prism(outline, low: float, high: float) -> list:
    count = len(outline)
    top = [(x, y, high) for x, y in outline]
    bottom = [(x, y, low) for x, y in outline]
    triangles = []
    for index in range(1, count - 1):
        triangles.append((top[0], top[index], top[index + 1]))
        triangles.append((bottom[0], bottom[index + 1], bottom[index]))
    for index in range(count):
        after = (index + 1) % count
        triangles.append((bottom[index], bottom[after], top[after]))
        triangles.append((bottom[index], top[after], top[index]))
    return triangles


def rectangle(low_x: float, low_y: float, high_x: float, high_y: float) -> list:
    return [(low_x, low_y), (high_x, low_y), (high_x, high_y), (low_x, high_y)]


def circle(radius: float, sides: int = 24) -> list:
    return [(radius * math.cos(2 * math.pi * index / sides), radius * math.sin(2 * math.pi * index / sides))
            for index in range(sides)]


def write(name: str, parts, material: str, note: str, collision=None) -> dict:
    """The model is solid to nothing without collision."""
    # One object and one material group: ModelDoc makes a bone of each, and
    # warns when two share a name.
    points, uvs, normals, faces = [], [], [], []
    vertex_base = corner_base = 0
    low, high = [math.inf] * 3, [-math.inf] * 3
    for part in parts:
        mesh = part.data
        mesh.transform(TO_GAME @ part.matrix_world)
        part.matrix_world = Matrix.Identity(4)
        mesh.calc_loop_triangles()
        layer = mesh.uv_layers.active
        for vertex in mesh.vertices:
            point = vertex.co
            for axis in range(3):
                low[axis], high[axis] = min(low[axis], point[axis]), max(high[axis], point[axis])
            points.append(f"v {point.y:.4f} {point.z:.4f} {point.x:.4f}")
        for loop in mesh.loops:
            uv = layer.data[loop.index].uv if layer else (0, 0)
            uvs.append(f"vt {uv[0]:.6f} {uv[1]:.6f}")
        for normal in mesh.corner_normals:
            n = normal.vector
            normals.append(f"vn {n.y:.6f} {n.z:.6f} {n.x:.6f}")
        for triangle in mesh.loop_triangles:
            faces.append("f " + " ".join(
                f"{vertex_base + vertex + 1}/{corner_base + loop + 1}/{corner_base + loop + 1}"
                for vertex, loop in zip(triangle.vertices, triangle.loops)))
        vertex_base += len(mesh.vertices)
        corner_base += len(mesh.loops)
    count = len(faces)
    lines = [f"# {note}", f"o {name}", *points, *uvs, *normals, "usemtl " + material, *faces]
    (MODELS / f"{name}.obj").write_text("\n".join(lines) + "\n")
    physics = ""
    if collision:
        corners, shape = {}, [f"# {name}: what a hero stands on and bumps into", f"o {name}_collision"]
        for triangle in collision:
            for x, y, z in triangle:
                if (x, y, z) not in corners:
                    corners[(x, y, z)] = len(corners) + 1
                    shape.append(f"v {y:.4f} {z:.4f} {x:.4f}")
        shape.extend("f " + " ".join(str(corners[corner]) for corner in triangle) for triangle in collision)
        (MODELS / f"{name}_collision.obj").write_text("\n".join(shape) + "\n")
        physics = f'''
   {{ _class = "PhysicsShapeList" children = [
    {{ _class = "PhysicsMeshFile" name = "collision" parent_bone = "" surface_prop = "default" collision_tags = "solid" filename = "models/pillars/{name}_collision.obj" import_scale = 1.0 }}
   ] }},'''
    (MODELS / f"{name}.vmdl").write_text(f'''<!-- kv3 encoding:text:version{{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d}} format:modeldoc28:version{{fb63b6ca-f435-4aa0-a2c7-c66ddc651dca}} -->
{{
 rootNode = {{
  _class = "RootNode"
  children = [
   {{ _class = "RenderMeshList" children = [
    {{ _class = "RenderMeshFile" filename = "models/pillars/{name}.obj" }}
   ] }},{physics}
   {{ _class = "MaterialGroupList" children = [
    {{ _class = "DefaultMaterialGroup" name = "default" remaps = [] use_global_default = false }}
   ] }}
  ]
 }}
}}
''')
    print("MODEL", name, "triangles", count, "bounds", [round(v) for v in low], [round(v) for v in high], flush=True)
    return {"model": f"models/pillars/{name}.vmdl", "triangles": count,
            "bounds": [[round(v, 2) for v in low], [round(v, 2) for v in high]]}


def tint(statue) -> list[int]:
    colours = statue.data.color_attributes.get("Color")
    if not colours or len(colours.data) == 0:
        return [255, 255, 255]
    total = [0.0, 0.0, 0.0]
    for item in colours.data:
        for axis in range(3):
            total[axis] += item.color[axis]
    def display(value: float) -> int:
        value = min(1.0, max(0.0, value))
        value = value * 12.92 if value <= 0.0031308 else 1.055 * value ** (1 / 2.4) - 0.055
        return round(value * 255)
    return [display(value / len(colours.data)) for value in total]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--exports", type=Path, default=ROOT.parents[1] / ".local/pillar-assets/exports",
                        help="the folder Source2Viewer exported the source models into")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    for key, source in SOURCES.items():
        if not (args.exports / (source + ".glb")).is_file():
            sys.exit(f"models: {source}.glb is not in {args.exports}")
    MODELS.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    record = {}

    top_size = LAYOUT["topSize"] * UNIT
    depth = LAYOUT["pillarDepth"] * UNIT
    pillar, _ = load(args.exports, "base")
    half = cut(pillar, BASE_TOP, FLAT_TOP)
    size = top_size / (2 * half)
    extra = depth / size - (FLAT_TOP - BASE_TOP)
    stretch(pillar, SPLIT, extra)
    pillar.matrix_world = Matrix.Translation((0, 0, -(FLAT_TOP + extra) * size)) @ Matrix.Scale(size, 4)
    length, thickness, height = (LAYOUT[key] * UNIT for key in ("wallLength", "wallThickness", "wallHeight"))
    wall = block((-thickness / 2, -length / 2, 0), (thickness / 2, length / 2, height))
    half_top = LAYOUT["topSize"] / 2
    half_long, half_thick = LAYOUT["wallLength"] / 2, LAYOUT["wallThickness"] / 2
    record["ringPillar"] = write(
        "ring_pillar", [pillar, wall], WALL,
        "park statue base: flat top with a low wall, body stretched into the void",
        prism(rectangle(-half_top, -half_top, half_top, half_top), -LAYOUT["pillarDepth"], 0)
        + prism(rectangle(-half_long, -half_thick, half_long, half_thick), 0, LAYOUT["wallHeight"]))

    deck_top = LAYOUT["centreZ"] * UNIT
    guard_size = LAYOUT["centreRadius"] * 2 * UNIT / GUARD_DECK
    head = deck_top - DECK_THICKNESS + 0.1
    base_z = head - GUARD_HEIGHT * guard_size
    guard, shift = load(args.exports, "guard")
    origin = TO_GAME @ (Vector((0, 0, base_z)) - shift * guard_size)
    record["guard"] = {"model": SOURCES["guard"] + ".vmdl", "scale": round(guard_size, 5),
                       "origin": [round(value, 2) for value in origin]}
    record["tint"] = tint(guard)
    bpy.data.objects.remove(guard, do_unlink=True)

    radius = LAYOUT["centreRadius"] * UNIT
    bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=radius, depth=DECK_THICKNESS,
                                        location=(0, 0, deck_top - DECK_THICKNESS / 2))
    deck = bpy.context.object
    column, _ = load(args.exports, "column")
    column_radius = 4.56 * guard_size * .75
    column_size = column_radius / 1.06
    stretch(column, 1.6, COLUMN_LENGTH / column_size - 3.25)
    scale_uvs(column, column_size)
    column.matrix_world = (Matrix.Translation((0, 0, base_z + .3 - COLUMN_LENGTH))
                           @ Matrix.Scale(column_size, 4))
    slab = LAYOUT["centreZ"] - round(DECK_THICKNESS / UNIT)
    record["centreColumn"] = write(
        "centre_column", [deck, column], STONE,
        "flat deck over the government column stretched into the void",
        prism(circle(LAYOUT["centreRadius"]), slab, LAYOUT["centreZ"])
        + prism(circle(column_radius / UNIT), -LAYOUT["pillarDepth"], slab))

    vines = [coil(args.exports, column_radius + .9, base_z - 20.0, base_z - 75.0, 17.0, phase, 4.5)
             for phase in (0.0, math.pi)]
    record["centreVines"] = write("centre_vines", vines, STONE, "bramble vines coiled round the column")

    first = wing(args.exports, .7)
    pose = (Matrix.Rotation(math.radians(-25), 4, "Y")
            @ Matrix.Rotation(math.atan2(3.9, 2.95), 4, "Z")
            @ Matrix.Rotation(math.radians(90), 4, "X"))
    wings = []
    for index in range(2):
        angle = math.radians(45 + 180 * index)
        fin = first
        if index:
            fin = first.copy()
            fin.data = first.data.copy()
            bpy.context.scene.collection.objects.link(fin)
        root = column_radius - .3
        fin.matrix_world = (Matrix.Translation((math.cos(angle) * root, math.sin(angle) * root, base_z - 12))
                            @ Matrix.Rotation(angle, 4, "Z") @ pose @ Matrix.Scale(2.6, 4))
        wings.append(fin)
    record["centreWings"] = write("centre_wings", wings, STONE, "dragon wings as fins on the column")

    RECORD.write_text(json.dumps(record, indent=2) + "\n")
    print("WROTE", RECORD, flush=True)


if __name__ == "__main__":
    main()
