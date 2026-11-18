package com.nmo.agentobserver.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import net.minecraft.client.Minecraft;
import net.minecraft.network.chat.Component;
import com.nmo.agentobserver.AgentObserverClient;

@Mixin(value = Minecraft.class, remap = false)
public final class MinecraftMixin {
    @Inject(method = "tick", at = @At("HEAD"), remap = false)
    private void agentObserver$showState(CallbackInfo callbackInfo) {
        Minecraft minecraft = (Minecraft)(Object)this;
        if (minecraft.gui != null) {
            minecraft.gui.setOverlayMessage(Component.literal(AgentObserverClient.overlay()), false);
        }
        AgentObserverClient.renderPathLines(minecraft);
    }
}
