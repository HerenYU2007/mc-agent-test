package com.nmo.agentobserver;

import org.lwjgl.glfw.GLFW;

import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.util.FormattedCharSequence;
import net.minecraft.world.item.ItemStack;

public final class ObserverHud {
    private ObserverHud() {}

    public static void tick(Minecraft minecraft) {
        ObserverHudLayout.updateDetailsKey(minecraft.level != null && minecraft.screen == null
            && InputConstants.isKeyDown(minecraft.getWindow(), GLFW.GLFW_KEY_K));
    }

    public static void render(Minecraft minecraft, GuiGraphicsExtractor gui) {
        if (minecraft.level == null || minecraft.player == null || minecraft.screen != null || minecraft.options.hideGui) return;
        float scale = Math.max(ObserverHudLayout.HUD_SCALE, 1.0F / minecraft.getWindow().getGuiScale());
        int width = (int) (gui.guiWidth() / scale);
        int height = (int) (gui.guiHeight() / scale);
        int aboveXp = (int) ((gui.guiHeight() - ObserverHudLayout.VANILLA_BOTTOM_MARGIN) / scale);
        gui.pose().pushMatrix();
        try {
            gui.pose().scale(scale);
            ObserverHudLayout.drawHud(new Surface(gui), minecraft.font, width, height, aboveXp);
        } finally {
            gui.pose().popMatrix();
        }
    }

    private record Surface(GuiGraphicsExtractor gui) implements ObserverHudLayout.Surface {
        public void fill(int x1, int y1, int x2, int y2, int color) { gui.fill(x1, y1, x2, y2, color); }
        public void text(Font font, String text, int x, int y, int color) { gui.text(font, text, x, y, color); }
        public void text(Font font, FormattedCharSequence text, int x, int y, int color) { gui.text(font, text, x, y, color); }
        public void item(Font font, ItemStack stack, int x, int y) {
            gui.fakeItem(stack, x, y);
            gui.itemDecorations(font, stack, x, y);
        }
    }
}
