"""Run: blender -b -t 8 --python scripts/assets/bebop-statue.py"""
import bpy, math, json
from pathlib import Path
from mathutils import Vector, Matrix

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.local/statue'
SOURCE = ROOT / 'content/citadel_addons/bebop_wars'
MODEL = SOURCE / 'models/bebop_wars/statue'
MATS = SOURCE / 'materials/bebop_wars/statue'
for p in (WORK, MODEL, MATS): p.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(ROOT / '.local/banner-renders/banner.blend'))
scene = bpy.context.scene
arm = next(o for o in scene.objects if o.type == 'ARMATURE')
bpy.context.view_layer.update()
arm.animation_data_clear()
for name, degrees in [('arm_upper_R', 25), ('arm_lower_R', 55)]:
 bone=arm.pose.bones[name]
 world=arm.matrix_world@bone.matrix
 pivot=Matrix.Translation(world.translation)
 bone.matrix=arm.matrix_world.inverted()@pivot@Matrix.Rotation(math.radians(-degrees),4,'X')@pivot.inverted()@world
 bpy.context.view_layer.update()
wrist = arm.matrix_world @ arm.pose.bones['hand_R'].head
forward = (wrist - arm.matrix_world @ arm.pose.bones['arm_lower_R'].head).normalized()
print('Wrist', list(wrist), 'direction', list(forward), flush=True)

stone = bpy.data.materials.new('materials/bebop_wars/statue/museum_slate.vmat'); stone.use_nodes = True
bs = stone.node_tree.nodes.get('Principled BSDF')
bs.inputs['Base Color'].default_value = (.214,.233,.263,1)
bs.inputs['Metallic'].default_value=0; bs.inputs['Roughness'].default_value=.9
accent=bpy.data.materials.new('materials/bebop_wars/statue/amber.vmat');accent.use_nodes=True
ab=accent.node_tree.nodes.get('Principled BSDF');ab.inputs['Base Color'].default_value=(.79,.485,.184,1);ab.inputs['Emission Color'].default_value=(.79,.485,.184,1);ab.inputs['Emission Strength'].default_value=.65;ab.inputs['Roughness'].default_value=.75

parts=[]
deps= bpy.context.evaluated_depsgraph_get()
for o in list(scene.objects):
 if o.type!='MESH' or o.hide_render:continue
 ev=o.evaluated_get(deps);mesh=bpy.data.meshes.new_from_object(ev);mesh.transform(ev.matrix_world)
 obj=bpy.data.objects.new('Stone '+o.name.rsplit('.',1)[-1],mesh);scene.collection.objects.link(obj);parts.append(obj)
 oldmats=list(mesh.materials)
 marked=set()
 for index,mat in enumerate(oldmats):
  if mat.name!='bebop_head':continue
  mask=next(n.image for n in mat.node_tree.nodes if n.type=='TEX_IMAGE' and 'pbr_color_3c' in n.image.name)
  pixels=list(mask.pixels);w,h=mask.size
  for poly in mesh.polygons:
   if poly.material_index!=index:continue
   uv=sum((mesh.uv_layers.active.data[i].uv for i in poly.loop_indices),Vector((0,0)))/len(poly.loop_indices)
   off=(int(uv.y%1*h)*w+int(uv.x%1*w))*4
   if max(pixels[off:off+3])>.2:marked.add(poly.index)
 mesh.materials.clear();mesh.materials.append(stone);mesh.materials.append(accent)
 for poly in mesh.polygons:poly.material_index=1 if poly.index in marked else 0
for o in list(scene.objects):
 if o not in parts:bpy.data.objects.remove(o,do_unlink=True)

before=set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=str(ROOT/'.local/banner-renders/hook/models/heroes_staging/bebop/bebop_hand_projectile.glb'))
hand=next(o for o in bpy.data.objects if o not in before and o.type=='MESH')
hand.data.transform(hand.matrix_world);hand.matrix_world=Matrix.Identity(4)
rear=max(v.co.y for v in hand.data.vertices)
rim=[v.co for v in hand.data.vertices if v.co.y>rear-.014]
rear_center=Vector((sum(v.x for v in rim)/len(rim),rear-.004,sum(v.z for v in rim)/len(rim)))
flight=(forward*.3+Vector((0,0,1))).normalized()
rotation=Vector((0,-1,0)).rotation_difference(flight)
endpoint=wrist+forward*.22+Vector((0,0,.18))
for v in hand.data.vertices:v.co=endpoint+rotation@(v.co-rear_center)
hand.data.materials.clear();hand.data.materials.append(stone);hand.name='Stone hook hand';parts.append(hand)
for o in list(bpy.data.objects):
 if o not in before and o!=hand:bpy.data.objects.remove(o,do_unlink=True)
controls=[wrist-forward*.035,wrist+forward*.13+Vector((0,0,.025)),endpoint-flight*.08,endpoint]
curve=bpy.data.curves.new('Carved hook cable','CURVE');curve.dimensions='3D';curve.resolution_u=20;curve.bevel_depth=.035;curve.bevel_resolution=3
spline=curve.splines.new('BEZIER');spline.bezier_points.add(3)
for p,co in zip(spline.bezier_points,controls):p.co=co;p.handle_left_type='AUTO';p.handle_right_type='AUTO'
cable=bpy.data.objects.new('Stone hook cable',curve);scene.collection.objects.link(cable);curve.materials.append(stone)
bpy.context.view_layer.objects.active=cable;cable.select_set(True);bpy.ops.object.convert(target='MESH');parts.append(bpy.context.object)

points=[o.matrix_world@v.co for o in parts for v in o.data.vertices]
low=Vector([min(v[i] for v in points) for i in range(3)]);high=Vector([max(v[i] for v in points) for i in range(3)])
feet=[v for v in points if v.z<low.z+.09]
center=Vector(((min(v.x for v in feet)+max(v.x for v in feet))/2,
               (min(v.y for v in feet)+max(v.y for v in feet))/2,low.z))
scale=344.4/(high.z-low.z)
# The asset faces +X in Source; Blender's native rig faces -Y.
turn=Matrix.Rotation(math.pi/2,3,'Z')
for o in parts:
 o.data.transform(turn.to_4x4()@Matrix.Scale(scale,4)@Matrix.Translation(-center)@o.matrix_world)
 o.matrix_world=Matrix.Identity(4)

for obj in parts:
 mesh=obj.data
 uv=mesh.uv_layers.new(name='StoneUV')
 for poly in mesh.polygons:
  n=poly.normal;axis=max(range(3),key=lambda a:abs(n[a]));axes=[i for i in range(3) if i!=axis]
  for loop in poly.loop_indices:
   co=mesh.vertices[mesh.loops[loop].vertex_index].co
   uv.data[loop].uv=(co[axes[0]]/32,co[axes[1]]/32)
 mesh.uv_layers.active=uv

# ModelDoc's OBJ importer maps (x,y,z) to (z,x,y).
def export_obj(path, objects, physics=False):
 lines=['# Authored static Bebop monument; units are Source inches.'];offset=0;uv_offset=0
 for obj in objects:
  mesh=obj.data;mesh.calc_loop_triangles();lines.append('o '+obj.name.replace(' ','_'))
  for v in mesh.vertices:lines.append('v %.6f %.6f %.6f'%(v.co.y,v.co.z,v.co.x))
  if not physics:
   for loop in mesh.loops:lines.append('vt %.6f %.6f'%tuple(mesh.uv_layers.active.data[loop.index].uv))
   for n in mesh.corner_normals:lines.append('vn %.6f %.6f %.6f'%(n.vector.y,n.vector.z,n.vector.x))
  material=-1
  for tri in mesh.loop_triangles:
   poly=mesh.polygons[tri.polygon_index]
   if poly.material_index!=material:
    material=poly.material_index;lines.append('usemtl '+mesh.materials[material].name)
   if physics:lines.append('f '+' '.join(str(offset+v+1) for v in tri.vertices))
   else:lines.append('f '+' '.join(f'{offset+v+1}/{uv_offset+l+1}/{uv_offset+l+1}' for v,l in zip(tri.vertices,tri.loops)))
  offset+=len(mesh.vertices)
  if not physics:uv_offset+=len(mesh.loops)
 path.write_text('\n'.join(lines)+'\n')
export_obj(MODEL/'bebop_statue.obj',parts)
collision=[]
for obj in parts:
 copy=obj.copy();copy.data=obj.data.copy();scene.collection.objects.link(copy)
 if len(copy.data.polygons)>1000:
  collision_low=[min(v.co[i] for v in obj.data.vertices) for i in range(3)]
  collision_high=[max(v.co[i] for v in obj.data.vertices) for i in range(3)]
  modifier=copy.modifiers.new('Collision simplification','DECIMATE');modifier.ratio=.25
  bpy.context.view_layer.objects.active=copy;bpy.ops.object.modifier_apply(modifier=modifier.name)
  for v in copy.data.vertices:
   for i in range(3):v.co[i]=max(collision_low[i],min(collision_high[i],v.co[i]))
 collision.append(copy)
export_obj(MODEL/'bebop_statue_collision.obj',collision,physics=True)
for obj in collision:bpy.data.objects.remove(obj,do_unlink=True)

scene.render.engine='CYCLES';scene.cycles.samples=40;scene.cycles.use_denoising=True
scene.render.resolution_x=840;scene.render.resolution_y=840;scene.render.resolution_percentage=100
scene.render.film_transparent=False;scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA'
scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.16,.20,.26,1);scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.5
scene.view_settings.view_transform='AgX'
# Scale preview to meters for physically sensible lights; exported coordinates stay inches.
for o in parts:o.scale=(.0254,)*3
height=(high.z-low.z)*scale*.0254
bpy.ops.mesh.primitive_cube_add(size=1,location=(0,0,-.45));ped=bpy.context.object;ped.scale=(3.75,3.75,.9);ped.data.materials.append(stone)
bevel=ped.modifiers.new('Stone edge','BEVEL');bevel.width=.05;bevel.segments=2
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.92));bpy.context.object.data.materials.append(stone)
def aim(o,p):o.rotation_euler=(Vector(p)-o.location).to_track_quat('-Z','Y').to_euler()
for name,position,power,size in [('Key',(4,-5,7),1400,5),('Fill',(0,5,5),900,4),('Rim',(-4,-1,6),1100,3)]:
 d=bpy.data.lights.new(name,'AREA');d.energy=power;d.shape='DISK';d.size=size;o=bpy.data.objects.new(name,d);scene.collection.objects.link(o);o.location=position;aim(o,(0,0,2))
d=bpy.data.cameras.new('Statue review');camera=bpy.data.objects.new('Statue review',d);scene.collection.objects.link(camera);scene.camera=camera;d.type='ORTHO';d.ortho_scale=max(6.2,height+2.2)
camera.location=(8,-9,6);aim(camera,(0,0,height*.43))
scene.render.filepath=str(WORK/'statue-amber.png');bpy.ops.render.render(write_still=True)
ab.inputs['Base Color'].default_value=(.275,.456,.807,1);ab.inputs['Emission Color'].default_value=(.275,.456,.807,1)
scene.render.filepath=str(WORK/'statue-blue.png');bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=str(WORK/'statue.blend'))
points=[v.co for o in parts for v in o.data.vertices]
(WORK/'geometry.json').write_text(json.dumps({'scale':scale,'bounds':[[min(v[i] for v in points) for i in range(3)],[max(v[i] for v in points) for i in range(3)]],'triangles':sum(len(o.data.loop_triangles) for o in parts),'wrist':list(wrist),'forward':list(forward)},indent=2))
