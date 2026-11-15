import bpy
import json
import math
from pathlib import Path
from mathutils import Matrix, Vector

ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/'.local/rooftop-preview'
SOURCE=ROOT/'content/citadel_addons/new_deadlock_game'
DATA=json.loads((WORK/'scene.json').read_text())
UNIT=.0254

bpy.ops.wm.read_factory_settings(use_empty=True)
scene=bpy.context.scene
scene.render.engine='CYCLES'
scene.cycles.samples=48
scene.cycles.use_denoising=True
scene.cycles.max_bounces=6
scene.cycles.transparent_max_bounces=12
prefs=bpy.context.preferences.addons['cycles'].preferences
prefs.compute_device_type='OPTIX';prefs.get_devices()
for device in prefs.devices:device.use=device.type!='CPU'
if any(d.use for d in prefs.devices):scene.cycles.device='GPU'
scene.render.resolution_x=1600;scene.render.resolution_y=1000
scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.view_settings.view_transform='AgX'
scene.view_settings.look='AgX - Medium High Contrast'
scene.view_settings.exposure=.6

materials={}
for name,spec in DATA['materials'].items():
    mat=bpy.data.materials.new(name);mat.use_nodes=True
    nodes=mat.node_tree.nodes;links=mat.node_tree.links
    bsdf=nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value=(*spec['color'],1)
    bsdf.inputs['Roughness'].default_value=.83
    if 'texture' in spec:
        texture=nodes.new('ShaderNodeTexImage')
        texture.image=bpy.data.images.load(str(SOURCE/'materials/rooftop'/spec['texture']),check_existing=True)
        multiply=nodes.new('ShaderNodeMixRGB');multiply.blend_type='MULTIPLY'
        multiply.inputs[0].default_value=1;multiply.inputs[2].default_value=(*spec['color'],1)
        links.new(texture.outputs['Color'],multiply.inputs[1]);links.new(multiply.outputs[0],bsdf.inputs['Base Color'])
        bump=nodes.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.3
        bump.inputs['Distance'].default_value=.018
        links.new(texture.outputs['Color'],bump.inputs['Height']);links.new(bump.outputs['Normal'],bsdf.inputs['Normal'])
    if 'emission' in spec:
        bsdf.inputs['Emission Color'].default_value=(*spec['color'],1)
        bsdf.inputs['Emission Strength'].default_value=spec['emission']
    materials[name]=mat

def axes(normal):
    x,y,z=(abs(c) for c in normal)
    if z>=x and z>=y:return (0,1)
    if x>=y:return (1,2)
    return (0,2)

for spec in DATA['meshes']:
    mesh=bpy.data.meshes.new(spec['name'])
    mesh.from_pydata([tuple(c*UNIT for c in v) for v in spec['vertices']],[],spec['faces']);mesh.update()
    obj=bpy.data.objects.new(spec['name'],mesh);scene.collection.objects.link(obj)
    mesh.materials.append(materials[spec['material']])
    uv=mesh.uv_layers.new(name='StoneUV')
    for poly in mesh.polygons:
        u,v=axes(poly.normal)
        for index in poly.loop_indices:
            co=mesh.vertices[mesh.loops[index].vertex_index].co
            uv.data[index].uv=(co[u]/(256*UNIT),-co[v]/(256*UNIT))
    if len(spec['faces'])>=6:
        bevel=obj.modifiers.new('Small stone arrises','BEVEL');bevel.width=.018;bevel.segments=2

native={}
for asset in sorted(set(p['asset'] for p in DATA['props'])):
    prop=next(p for p in DATA['props'] if p['asset']==asset)
    file=ROOT/'.local/asset-review/exports'/Path(prop['model']).with_suffix('.glb')
    before=set(scene.objects)
    bpy.ops.import_scene.gltf(filepath=str(file))
    imported=set(scene.objects)-before
    bpy.context.view_layer.update()
    deps=bpy.context.evaluated_depsgraph_get()
    parts=[]
    for obj in imported:
        if obj.type!='MESH':continue
        if asset=='amber_patron' and 'beam' in obj.name.lower():continue
        if asset=='sapphire_patron' and 'phase3' in obj.name.lower():continue
        mesh=bpy.data.meshes.new_from_object(obj.evaluated_get(deps))
        mesh.transform(Matrix.Rotation(math.pi/2,4,'Z')@obj.matrix_world)
        parts.append(mesh)
    for obj in imported:bpy.data.objects.remove(obj,do_unlink=True)
    native[asset]=parts

# Native coat translucency uses a second UV set and a gradient; the glTF
# conversion retains only its animated noise mask. Reconstruct the static mask.
for mat in bpy.data.materials:
    if not mat.use_nodes:continue
    nodes=mat.node_tree.nodes;links=mat.node_tree.links
    bsdf=nodes.get('Principled BSDF')
    if bsdf is None:continue
    if mat.name.startswith('backdrop_building_facade_01'):
        # glTF omits the native parallax shader's window layer.
        windows=nodes.new('ShaderNodeTexImage')
        windows.image=bpy.data.images.load(str(ROOT/'.local/asset-review/layered/g_tColor2.png'),check_existing=True)
        tint=nodes.new('ShaderNodeMixRGB');tint.blend_type='MULTIPLY';tint.inputs[0].default_value=1
        if bsdf.inputs['Base Color'].links:
            links.new(bsdf.inputs['Base Color'].links[0].from_socket,tint.inputs[1])
        else:tint.inputs[1].default_value=bsdf.inputs['Base Color'].default_value
        links.new(windows.outputs['Color'],tint.inputs[2]);links.new(tint.outputs[0],bsdf.inputs['Base Color'])
    if mat.name=='patron_amber_coat':
        for socket in ('Base Color','Alpha'):
            for link in list(bsdf.inputs[socket].links):links.remove(link)
        bsdf.inputs['Base Color'].default_value=(.028,.024,.022,1)
        uv=nodes.new('ShaderNodeUVMap');uv.uv_map='UVMap.001'
        gradient=nodes.new('ShaderNodeTexImage')
        gradient.image=bpy.data.images.load(str(WORK/'patron/coat-gradient.png'));gradient.image.colorspace_settings.name='Non-Color'
        links.new(uv.outputs['UV'],gradient.inputs['Vector'])
        threshold=nodes.new('ShaderNodeMath');threshold.operation='GREATER_THAN';threshold.inputs[1].default_value=.15
        links.new(gradient.outputs['Color'],threshold.inputs[0]);links.new(threshold.outputs[0],bsdf.inputs['Alpha'])
    if mat.name=='patron_amber_body':
        for link in list(bsdf.inputs['Emission Color'].links):links.remove(link)
        mask=nodes.new('ShaderNodeTexImage');mask.image=bpy.data.images.load(str(WORK/'patron/body-emission.png'))
        mask.image.colorspace_settings.name='Non-Color'
        strength=nodes.new('ShaderNodeMath');strength.operation='MULTIPLY';strength.inputs[1].default_value=3
        links.new(mask.outputs['Color'],strength.inputs[0]);links.new(strength.outputs[0],bsdf.inputs['Emission Strength'])
        tint=nodes.new('ShaderNodeMixRGB');tint.blend_type='MULTIPLY';tint.inputs[0].default_value=1
        tint.inputs[2].default_value=(.992,.741,0,1)
        albedo=bsdf.inputs['Base Color'].links[0].from_socket
        links.new(albedo,tint.inputs[1]);links.new(tint.outputs[0],bsdf.inputs['Emission Color'])
    if mat.name=='patron_amber_eyes':
        for link in list(bsdf.inputs['Emission Color'].links):links.remove(link)
        bsdf.inputs['Emission Color'].default_value=(1,.76,.102,1);bsdf.inputs['Emission Strength'].default_value=10

for prop in DATA['props']:
    matrix=Matrix.Translation(Vector(prop['origin'])*UNIT)@Matrix.Rotation(math.radians(prop['yaw']),4,'Z')@Matrix.Scale(prop['scale'],4)
    for index,mesh in enumerate(native[prop['asset']]):
        obj=bpy.data.objects.new(f"{prop['name']}_{index}",mesh);scene.collection.objects.link(obj)
        obj.matrix_world=matrix

def aim(obj,target):
    obj.rotation_euler=(Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()

for spec in DATA['lights']:
    light=bpy.data.lights.new(spec['name'],'POINT');light.energy=spec['power']*.08
    light.color=spec['color'];light.shadow_soft_size=.15
    obj=bpy.data.objects.new(spec['name'],light);scene.collection.objects.link(obj)
    obj.location=Vector(spec['position'])*UNIT

world=bpy.data.worlds.new('Deadlock sunset sky');scene.world=world;world.use_nodes=True
nodes=world.node_tree.nodes;links=world.node_tree.links
bg=nodes.get('Background');bg.inputs['Strength'].default_value=.9
sky_files=list((WORK/'sky').rglob('*.exr'))+list((WORK/'sky').rglob('*.hdr'))+list((WORK/'sky').rglob('*.png'))
if sky_files:
    env=nodes.new('ShaderNodeTexEnvironment');env.image=bpy.data.images.load(str(sky_files[0]))
    coords=nodes.new('ShaderNodeTexCoord');mapping=nodes.new('ShaderNodeMapping')
    mapping.inputs['Rotation'].default_value[2]=math.radians(35)
    links.new(coords.outputs['Generated'],mapping.inputs['Vector'])
    links.new(mapping.outputs['Vector'],env.inputs['Vector'])
    links.new(env.outputs['Color'],bg.inputs['Color'])
else:
    bg.inputs['Color'].default_value=(.28,.20,.36,1)

sun=bpy.data.lights.new('Sunset direct light','SUN');sun.energy=2.5;sun.color=(1,.58,.31);sun.angle=math.radians(4)
obj=bpy.data.objects.new('Sunset direct light',sun);scene.collection.objects.link(obj)
obj.location=(-100,130,85);aim(obj,(0,0,0))

bpy.ops.mesh.primitive_cube_add(size=2,location=(0,0,-35))
fog=bpy.context.object;fog.name='Preview atmospheric haze';fog.scale=(800,800,450)
fogmat=bpy.data.materials.new('Preview distance haze');fogmat.use_nodes=True
nodes=fogmat.node_tree.nodes;nodes.clear()
vol=nodes.new('ShaderNodeVolumeScatter');vol.inputs['Color'].default_value=(.52,.42,.62,1)
vol.inputs['Density'].default_value=.00045;vol.inputs['Anisotropy'].default_value=.25
out=nodes.new('ShaderNodeOutputMaterial');fogmat.node_tree.links.new(vol.outputs['Volume'],out.inputs['Volume'])
fog.data.materials.append(fogmat)

low=DATA['lowMist']
center=(Vector(low['mins'])+Vector(low['maxs']))*.5*UNIT
extent=(Vector(low['maxs'])-Vector(low['mins']))*.5*UNIT
bpy.ops.mesh.primitive_cube_add(size=2,location=center)
low_fog=bpy.context.object;low_fog.name='Preview low city mist';low_fog.scale=extent
low_mat=bpy.data.materials.new('Preview city mist');low_mat.use_nodes=True
nodes=low_mat.node_tree.nodes;nodes.clear()
vol=nodes.new('ShaderNodeVolumeScatter');vol.inputs['Color'].default_value=(.55,.52,.61,1)
vol.inputs['Density'].default_value=.002;vol.inputs['Anisotropy'].default_value=.15
out=nodes.new('ShaderNodeOutputMaterial');low_mat.node_tree.links.new(vol.outputs['Volume'],out.inputs['Volume'])
low_fog.data.materials.append(low_mat)

camera_data=bpy.data.cameras.new('Rooftop preview');camera=bpy.data.objects.new('Rooftop preview',camera_data)
scene.collection.objects.link(camera);scene.camera=camera
camera_data.clip_start=.1;camera_data.clip_end=3000
for name,spec in DATA['cameras'].items():
    camera.location=Vector(spec['position'])*UNIT;aim(camera,Vector(spec['target'])*UNIT)
    camera_data.type='ORTHO' if 'orthographic' in spec else 'PERSP'
    camera_data.lens=spec.get('lens',28)
    camera_data.ortho_scale=spec.get('orthographic',3200)*UNIT
    fog.hide_render=name=='plan'
    low_fog.hide_render=name=='plan'
    scene.render.resolution_y=1000 if name!='plan' else 1600
    scene.render.filepath=str(WORK/f'{name}.png')
    bpy.ops.render.render(write_still=True)
    print('RENDERED',name,flush=True)
camera.location=Vector(DATA['cameras']['rooftop']['position'])*UNIT
aim(camera,Vector(DATA['cameras']['rooftop']['target'])*UNIT)
camera_data.type='PERSP';camera_data.lens=DATA['cameras']['rooftop']['lens'];fog.hide_render=False
scene.render.resolution_y=1000
bpy.ops.wm.save_as_mainfile(filepath=str(WORK/'rooftop.blend'))
