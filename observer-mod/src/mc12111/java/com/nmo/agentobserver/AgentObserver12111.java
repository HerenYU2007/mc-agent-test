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
import com.nmo.agentobserver.ObserverSettings12111.Display;

public final class AgentObserver12111 implements ClientModInitializer {
    private final ObserverSettings12111 settings = new ObserverSettings12111();
    private boolean settingsKeyDown;
    private LocalPlayer nightVisionPlayer;
    private MobEffectInstance injectedNightVision;

    @Override
    public void onInitializeClient() {
        ObserverTelemetry.start();
        new ObserverOres12111().register(settings);
        ObserverStructures12111 scanner = new ObserverStructures12111();
        scanner.register(settings);
        ObserverStructureOverlay12111 structures = new ObserverStructureOverlay12111(scanner, settings);
        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            updateSettingsKey(client);
            updateNightVision(client.player);
            structures.tick(client);
            ObserverHudLayout.updateDetailsKey(client.level != null && client.screen == null
                && InputConstants.isKeyDown(client.getWindow(), GLFW.GLFW_KEY_K));
        });
        HudElementRegistry.addLast(Identifier.fromNamespaceAndPath("nmo-agent-observer", "telemetry"),
            (graphics, delta) -> renderHud(Minecraft.getInstance(), graphics));
        HudElementRegistry.addLast(Identifier.fromNamespaceAndPath("nmo-agent-observer", "structure_legend"),
            (graphics, delta) -> {
                Minecraft client = Minecraft.getInstance();
                if (client.screen != null || client.options.hideGui || !settings.enabled(Display.STRUCTURES)) return;
                String legend = structures.legend();
                if (!legend.isEmpty()) graphics.drawString(client.font, legend, 6, graphics.guiHeight() - 82, 0xFFE7FFF7, true);
            });
        ObserverPath12111 path = new ObserverPath12111();
        WorldRenderEvents.END_MAIN.register(context -> {
            structures.render(context);
            if (settings.enabled(Display.ROUTE)) path.render(context);
        });
        ClientLifecycleEvents.CLIENT_STOPPING.register(client -> {
            structures.close();
            path.close();
        });
    }

    private void updateSettingsKey(Minecraft client) {
        boolean down = client.level != null && client.isWindowActive() &&
            InputConstants.isKeyDown(client.getWindow(), GLFW.GLFW_KEY_F7);
        if (down && !settingsKeyDown) {
            if (client.screen == null) client.setScreen(new ObserverSettingsScreen12111(settings));
            else if (client.screen instanceof ObserverSettingsScreen12111) client.setScreen(null);
        }
        settingsKeyDown = down;
    }

    private void updateNightVision(LocalPlayer player) {
        if (nightVisionPlayer != player) {
            nightVisionPlayer = player;
            injectedNightVision = null;
        }
        if (player == null) return;
        MobEffectInstance effect = player.getEffect(MobEffects.NIGHT_VISION);
        if (!settings.enabled(Display.NIGHT_VISION)) {
            if (effect != null && effect == injectedNightVision && effect.isInfiniteDuration()) {
                player.removeEffect(MobEffects.NIGHT_VISION);
            }
            injectedNightVision = null;
            return;
        }
        if (effect == null) {
            injectedNightVision = new MobEffectInstance(MobEffects.NIGHT_VISION, MobEffectInstance.INFINITE_DURATION,
                0, false, false, false);
            player.addEffect(injectedNightVision);
        }
        player.removeEffect(MobEffects.DARKNESS);
        player.removeEffect(MobEffects.BLINDNESS);
    }

    private void renderHud(Minecraft client, GuiGraphics gui) {
        if (client.level == null || client.player == null || client.screen != null || client.options.hideGui) return;
        float scale = Math.max(ObserverHudLayout.HUD_SCALE, 1.0F / client.getWindow().getGuiScale());
        int width = (int) (gui.guiWidth() / scale);
        int height = (int) (gui.guiHeight() / scale);
        int aboveXp = (int) ((gui.guiHeight() - ObserverHudLayout.VANILLA_BOTTOM_MARGIN) / scale);
        gui.pose().pushMatrix();
        try {
            gui.pose().scale(scale);
            ObserverHudLayout.drawHud(new Surface(gui), client.font, width, height, aboveXp,
                settings.enabled(Display.STATUS), settings.enabled(Display.INVENTORY));
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
