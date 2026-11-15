# OBJ coordinates follow the ModelDoc import convention.
import bmesh
import bpy
import json
import math
from mathutils import Matrix, Vector
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'content/citadel_addons/new_deadlock_game'
EXPORTS=ROOT/'.local/asset-review/exports'
MODEL=SOURCE/'models/rooftop'
MODEL.mkdir(parents=True,exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(EXPORTS/'models/buildings_background/background_building02a.glb'))
bpy.context.view_layer.update()
parts=[o for o in bpy.context.scene.objects if o.type=='MESH']
native_to_source=Matrix.Rotation(math.pi/2,4,'Z')@Matrix.Scale(1/.0254,4)
cut=7350
scale=2.38
footprint_scale=1.2
center=Vector((-285.5,-2,cut))
for obj in parts:
    obj.data.transform(native_to_source@obj.matrix_world)
    obj.matrix_world=Matrix.Identity(4)
    bm=bmesh.new();bm.from_mesh(obj.data)
    bmesh.ops.bisect_plane(bm,geom=list(bm.verts)+list(bm.edges)+list(bm.faces),
                           plane_co=(0,0,cut),plane_no=(0,0,1),dist=.001,
                           clear_outer=True,clear_inner=False)
    bm.to_mesh(obj.data);bm.free()
    for vertex in obj.data.vertices:
        vertex.co=(vertex.co-center)*scale+Vector((0,0,-28))
        vertex.co.x*=footprint_scale
        vertex.co.y*=footprint_scale
    for mat in obj.data.materials:
        mat.name='models/buildings_background/materials/'+mat.name+'.vmat'
    obj.data.update()
lines=['# building_02: cropped shaft, 20% wider footprint, native materials and UVs']
vo=0;uv_offset=0
for obj in parts:
    mesh=obj.data;mesh.calc_loop_triangles()
    lines.append('o ArenaBuilding02')
    for vertex in mesh.vertices:
        v=vertex.co;lines.append(f'v {v.y:.6f} {v.z:.6f} {v.x:.6f}')
    for loop in mesh.loops:
        uv=mesh.uv_layers.active.data[loop.index].uv;lines.append(f'vt {uv.x:.6f} {uv.y:.6f}')
    for normal in mesh.corner_normals:
        n=normal.vector;lines.append(f'vn {n.y:.6f} {n.z:.6f} {n.x:.6f}')
    last=None
    for tri in mesh.loop_triangles:
        mat=mesh.polygons[tri.polygon_index].material_index
        if mat!=last:lines.append('usemtl '+mesh.materials[mat].name);last=mat
        lines.append('f '+' '.join(f'{vo+v+1}/{uv_offset+l+1}/{uv_offset+l+1}' for v,l in zip(tri.vertices,tri.loops)))
    vo+=len(mesh.vertices);uv_offset+=len(mesh.loops)
(MODEL/'arena_building02.obj').write_text('\n'.join(lines)+'\n')
(MODEL/'arena_building02.vmdl').write_text('''<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:modeldoc28:version{fb63b6ca-f435-4aa0-a2c7-c66ddc651dca} -->
{
 rootNode = {
  _class = "RootNode"
  children = [
   { _class = "RenderMeshList" children = [
    { _class = "RenderMeshFile" filename = "models/rooftop/arena_building02.obj" }
   ] },
   { _class = "MaterialGroupList" children = [
    { _class = "DefaultMaterialGroup" name = "default" remaps = [] use_global_default = false }
   ] }
  ]
 }
}
''')
points=[v.co for obj in parts for v in obj.data.vertices]
bounds=[[min(v[i] for v in points) for i in range(3)],[max(v[i] for v in points) for i in range(3)]]
assets_path=ROOT/'scripts/rooftop-assets.json';assets=json.loads(assets_path.read_text())
assets['arena_tower']={'model':'models/rooftop/arena_building02.vmdl','bounds':bounds}
assets_path.write_text(json.dumps(assets,indent=2)+'\n')
# Match the coordinate convention of the native glTF exports for the preview.
for obj in parts:obj.data.transform(Matrix.Rotation(-math.pi/2,4,'Z')@Matrix.Scale(.0254,4))
preview=EXPORTS/'models/rooftop/arena_building02.glb';preview.parent.mkdir(parents=True,exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(preview),export_format='GLB',export_animations=False)
print('TOWER',bounds,'vertices',vo,flush=True)
