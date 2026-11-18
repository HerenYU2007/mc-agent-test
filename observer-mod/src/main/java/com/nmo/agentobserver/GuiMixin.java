package com.nmo.agentobserver.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import com.nmo.agentobserver.ObserverHud;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Gui;
import net.minecraft.client.gui.GuiGraphicsExtractor;

@Mixin(value = Gui.class, remap = false)
public final class GuiMixin {
    @Inject(method = "extractRenderState", at = @At("TAIL"), remap = false)
    private void agentObserver$drawHud(GuiGraphicsExtractor gui, DeltaTracker deltaTracker, CallbackInfo callbackInfo) {
        ObserverHud.render(Minecraft.getInstance(), gui);
    }
}
