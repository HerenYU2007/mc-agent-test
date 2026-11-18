package com.nmo.agentobserver.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import net.minecraft.client.Minecraft;
import com.nmo.agentobserver.AgentObserverClient;
import com.nmo.agentobserver.ObserverHud;

@Mixin(value = Minecraft.class, remap = false)
public final class MinecraftMixin {
    @Inject(method = "tick", at = @At("HEAD"), remap = false)
    private void agentObserver$showState(CallbackInfo callbackInfo) {
        Minecraft minecraft = (Minecraft)(Object)this;
        ObserverHud.tick(minecraft);
        AgentObserverClient.renderPathLines(minecraft);
    }
}
