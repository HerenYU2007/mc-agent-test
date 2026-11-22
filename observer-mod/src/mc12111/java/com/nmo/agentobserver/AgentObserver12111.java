package com.nmo.agentobserver;

import org.lwjgl.glfw.GLFW;

import com.mojang.blaze3d.platform.InputConstants;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.fabricmc.fabric.api.client.rendering.v1.world.WorldRenderEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.resources.Identifier;
import net.minecraft.util.FormattedCharSequence;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.item.ItemStack;

public final class AgentObserver12111 implements ClientModInitializer {
    @Override
    public void onInitializeClient() {
        ObserverTelemetry.start();
        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            if (client.player != null) applyNightVision(client.player);
            ObserverHudLayout.updateDetailsKey(client.level != null && client.screen == null
                && InputConstants.isKeyDown(client.getWindow(), GLFW.GLFW_KEY_K));
        });
        HudElementRegistry.addLast(Identifier.fromNamespaceAndPath("nmo-agent-observer", "telemetry"),
            (graphics, delta) -> renderHud(Minecraft.getInstance(), graphics));
        ObserverPath12111 path = new ObserverPath12111();
        WorldRenderEvents.END_MAIN.register(path::render);
        ClientLifecycleEvents.CLIENT_STOPPING.register(client -> path.close());
    }

    private static void applyNightVision(LocalPlayer player) {
        // CatEyes applies the vanilla effect to the local player. Refresh it if a world change
        // or a server effect update replaces it.
        MobEffectInstance effect = player.getEffect(MobEffects.NIGHT_VISION);
        if (effect == null || !effect.isInfiniteDuration()) {
            int amplifier = effect == null ? 0 : effect.getAmplifier();
            player.addEffect(new MobEffectInstance(MobEffects.NIGHT_VISION, MobEffectInstance.INFINITE_DURATION,
                amplifier, false, false, false));
        }
        player.removeEffect(MobEffects.DARKNESS);
        player.removeEffect(MobEffects.BLINDNESS);
    }

    private static void renderHud(Minecraft client, GuiGraphics gui) {
        if (client.level == null || client.player == null || client.screen != null || client.options.hideGui) return;
        float scale = Math.max(ObserverHudLayout.HUD_SCALE, 1.0F / client.getWindow().getGuiScale());
        int width = (int) (gui.guiWidth() / scale);
        int height = (int) (gui.guiHeight() / scale);
        int aboveXp = (int) ((gui.guiHeight() - ObserverHudLayout.VANILLA_BOTTOM_MARGIN) / scale);
        gui.pose().pushMatrix();
        try {
            gui.pose().scale(scale);
            ObserverHudLayout.drawHud(new Surface(gui), client.font, width, height, aboveXp);
        } finally {
            gui.pose().popMatrix();
        }
    }

    private record Surface(GuiGraphics gui) implements ObserverHudLayout.Surface {
        public void fill(int x1, int y1, int x2, int y2, int color) { gui.fill(x1, y1, x2, y2, color); }
        public void text(Font font, String text, int x, int y, int color) { gui.drawString(font, text, x, y, color); }
        public void text(Font font, FormattedCharSequence text, int x, int y, int color) { gui.drawString(font, text, x, y, color); }
        public void item(Font font, ItemStack stack, int x, int y) {
            gui.renderFakeItem(stack, x, y);
            gui.renderItemDecorations(font, stack, x, y);
        }
    }
}
