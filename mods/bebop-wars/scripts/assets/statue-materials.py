from pathlib import Path
import numpy as np
from PIL import Image

ROOT=Path(__file__).resolve().parents[2]
DEST=ROOT/'content/citadel_addons/bebop_wars/materials/bebop_wars/statue'
DEST.mkdir(parents=True,exist_ok=True)
size=512
rng=np.random.default_rng(19)
def noise(cells):
 grid=rng.random((cells,cells));axis=np.arange(size)*cells/size;i=axis.astype(int);f=axis-i;f=f*f*(3-2*f)
 top=grid[i[:,None],i]*(1-f)+grid[i[:,None],(i+1)%cells]*f
 bottom=grid[(i[:,None]+1)%cells,i]*(1-f)+grid[(i[:,None]+1)%cells,(i+1)%cells]*f
 return top*(1-f[:,None])+bottom*f[:,None]
broad=noise(4);grain=noise(64);pores=noise(128)
height=.65*grain+.35*pores
value=(broad-.5)*30+(grain-.5)*14+(pores-.5)*7
color=np.clip(np.array([87,96,105])+value[:,:,None],0,255).astype(np.uint8)
Image.fromarray(color).save(DEST/'stone_color.tga')
dx=(np.roll(height,-1,axis=1)-np.roll(height,1,axis=1))*.6
dy=(np.roll(height,-1,axis=0)-np.roll(height,1,axis=0))*.6
normal=np.stack((-dx,dy,np.ones_like(dx)),axis=-1);normal/=np.linalg.norm(normal,axis=-1,keepdims=True)
Image.fromarray(np.round((normal*.5+.5)*255).astype(np.uint8)).save(DEST/'stone_normal.tga')
Image.fromarray(np.round(224+grain*18).astype(np.uint8)).save(DEST/'stone_rough.tga')
(DEST/'museum_slate.vmat').write_text('''"Layer0"
{
 "shader" "pbr.vfx"
 "TextureColor1" "materials/bebop_wars/statue/stone_color.tga"
 "TextureNormal1" "materials/bebop_wars/statue/stone_normal.tga"
 "TextureRoughness1" "materials/bebop_wars/statue/stone_rough.tga"
 "TextureMetalness1" "[0 0 0 0]"
 "g_vColorTint1" "[1 1 1 1]"
 "g_vAlbedoTexcoordScale1" "[1.0 1.0 0.0 0.0]"
 "g_vNormalTexcoordScale1" "[1.0 1.0 0.0 0.0]"
 "g_flOpacityScale1" "1.0"
 "g_flHighlightTintBrightness1" "1.0"
 "g_flSelfIllumScale1" "0.0"
 "g_flVertexAOAmount1" "1.0"
 "Attributes" { "physSurfaceProperties" "rock" }
}
''')
for name,color in [('amber','E6B977'),('sapphire','8FB4E8')]:
 Image.new('RGB',(4,4),tuple(int(color[i:i+2],16) for i in (0,2,4))).save(DEST/f'{name}_color.tga')
 (DEST/f'{name}.vmat').write_text(f'''"Layer0"
{{
 "shader" "pbr.vfx"
 "F_SELF_ILLUM" "1"
 "TextureColor1" "materials/bebop_wars/statue/{name}_color.tga"
 "TextureRoughness1" "[0.78 0.78 0.78 0]"
 "TextureMetalness1" "[0 0 0 0]"
 "g_vColorTint1" "[1 1 1 1]"
 "g_vAlbedoTexcoordScale1" "[1.0 1.0 0.0 0.0]"
 "g_vNormalTexcoordScale1" "[1.0 1.0 0.0 0.0]"
 "g_vSelfIllumTexcoordScale1" "[1.0 1.0 0.0 0.0]"
 "g_flOpacityScale1" "1.0"
 "g_flHighlightTintBrightness1" "1.0"
 "g_flVertexAOAmount1" "1.0"
 "g_flSelfIllumAlbedoFactor1" "1.0"
 "g_flSelfIllumScale1" "0.65"
 "g_vSelfIllumTint1" "[1 1 1 1]"
 "Attributes" {{ "physSurfaceProperties" "rock" }}
}}
''')
