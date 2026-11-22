package com.nmo.agentobserver.mixin;

import net.minecraft.client.renderer.LightTexture;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyArg;

@Mixin(LightTexture.class)
abstract class ObserverLightTexture12111 {
    private static final String PUT_FLOAT =
        "Lcom/mojang/blaze3d/buffers/Std140Builder;putFloat(F)Lcom/mojang/blaze3d/buffers/Std140Builder;";

    // Positions of NightVisionFactor and BrightnessFactor in the 1.21.11 lightmap uniforms.
    @ModifyArg(method = "updateLightTexture", at = {
        @At(value = "INVOKE", target = PUT_FLOAT, ordinal = 3),
        @At(value = "INVOKE", target = PUT_FLOAT, ordinal = 6)
    }, index = 0, require = 2)
    private float nmo$maximumVisibility(float original) {
        return 1.0F;
    }
}
