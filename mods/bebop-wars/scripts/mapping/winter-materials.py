from PIL import Image
from runtime import SOURCE

folder = SOURCE / 'materials/mapping'
# Compiled opaque PBR color alpha is repacked by the shader compiler.
Image.new('RGBA', (8, 8), (255, 255, 255, 255)).save(folder / 'winter_white.tga')
params = {
    'shader': 'pbr.vfx',
    'TextureColor1': 'materials/mapping/winter_white.tga',
    'g_vColorTint1': '[0.055 0.075 0.09 1.0]',
    'g_flOpacityScale1': '1.0',
    'TextureRoughness1': '[0.45 0.45 0.45 1.0]',
    'TextureMetalness1': '[0.0 0.0 0.0 1.0]',
}
(folder / 'winter_dark_metal.vmat').write_text('"Layer0"\n{\n' + ''.join(
    f' "{key}" "{value}"\n' for key, value in params.items()) + '}\n')
print('winter_dark_metal')
