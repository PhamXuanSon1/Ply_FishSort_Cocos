"""
Render ảnh xem trước 1 con cá Fishdom (nhìn ngang, texture, nền trong suốt).

    blender -b --factory-startup --python preview.py -- <fbx> <png> <out.png> [size]

Vùng alpha < 0.5 của texture bị cắt bỏ giống material Fish (USE_ALPHA_TEST) trong game.
In ra dòng "RESULT {json}".
"""
import bpy, sys, os, json, mathutils

argv = sys.argv[sys.argv.index("--") + 1:]
fbx, png, out = argv[0], argv[1], argv[2]
size = int(argv[3]) if len(argv) > 3 else 512

bpy.ops.wm.read_factory_settings(use_empty=True)
if hasattr(bpy.ops.wm, "fbx_import"):
    bpy.ops.wm.fbx_import(filepath=fbx)
else:
    bpy.ops.import_scene.fbx(filepath=fbx)

meshes = [o for o in bpy.data.objects if o.type == 'MESH']

# 1 material: texture làm màu, alpha cắt ở 0.5 (emission để màu đúng texture, không phụ thuộc đèn)
mat = bpy.data.materials.new("preview")
mat.use_nodes = True
nt = mat.node_tree
nt.nodes.clear()
outn = nt.nodes.new('ShaderNodeOutputMaterial')
if png and os.path.isfile(png):
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(png)
    emit = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(tex.outputs['Color'], emit.inputs['Color'])
    clip = nt.nodes.new('ShaderNodeMath')
    clip.operation = 'GREATER_THAN'
    clip.inputs[1].default_value = 0.5
    nt.links.new(tex.outputs['Alpha'], clip.inputs[0])
    transp = nt.nodes.new('ShaderNodeBsdfTransparent')
    mix = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(clip.outputs[0], mix.inputs['Fac'])
    nt.links.new(transp.outputs[0], mix.inputs[1])
    nt.links.new(emit.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], outn.inputs['Surface'])
else:
    emit = nt.nodes.new('ShaderNodeEmission')
    emit.inputs['Color'].default_value = (0.8, 0.3, 0.8, 1)
    nt.links.new(emit.outputs[0], outn.inputs['Surface'])
if hasattr(mat, "surface_render_method"):
    mat.surface_render_method = 'DITHERED'
elif hasattr(mat, "blend_method"):
    mat.blend_method = 'CLIP'
mat.use_backface_culling = False
for o in meshes:
    o.data.materials.clear()
    o.data.materials.append(mat)

# khung bao: trục dài nhất (trừ trục bề ngang X) là chiều dài cá, nhìn từ bên hông (+X)
bpy.context.view_layer.update()
pts = [o.matrix_world @ mathutils.Vector(c) for o in meshes for c in o.bound_box]
mn = mathutils.Vector([min(p[i] for p in pts) for i in range(3)])
mx = mathutils.Vector([max(p[i] for p in pts) for i in range(3)])
center = (mn + mx) / 2
dim = mx - mn
side = 0 if dim.x <= min(dim.y, dim.z) else (1 if dim.y <= dim.z else 2)  # trục mỏng nhất = bề ngang
view = mathutils.Vector((0, 0, 0))
view[side] = 1

cam_data = bpy.data.cameras.new("cam")
cam_data.type = 'ORTHO'
others = [i for i in range(3) if i != side]
cam_data.ortho_scale = max(dim[i] for i in others) * 1.12
cam_data.clip_start = 0.001
cam_data.clip_end = max(dim) * 20 + 10
cam = bpy.data.objects.new("cam", cam_data)
bpy.context.scene.collection.objects.link(cam)
cam.location = center + view * max(dim) * 5
cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()  # trục Y camera = lên (Z thế giới)
bpy.context.scene.camera = cam

scene = bpy.context.scene
engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
scene.render.engine = next((e for e in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT') if e in engines), 'CYCLES')
if scene.render.engine == 'CYCLES':
    scene.cycles.samples = 16
scene.render.film_transparent = True
scene.render.resolution_x = size
scene.render.resolution_y = size
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.view_settings.view_transform = 'Standard'
scene.render.filepath = out
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
bpy.ops.render.render(write_still=True)

print("RESULT " + json.dumps({"out": out, "engine": scene.render.engine, "size": [round(d, 4) for d in dim]}))
