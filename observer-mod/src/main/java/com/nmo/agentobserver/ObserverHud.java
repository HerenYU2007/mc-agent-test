package com.nmo.agentobserver;

import java.text.NumberFormat;
import java.util.List;
import java.util.Locale;

import org.lwjgl.glfw.GLFW;

import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.world.item.ItemStack;

public final class ObserverHud {
    private static final int PANEL = 0xE6172223;
    private static final int BORDER = 0xFF4A625C;
    private static final int FG = 0xFFEAF6F1;
    private static final int MUTED = 0xFFB2C5BE;
    private static final int GOOD = 0xFF8BD4B5;
    private static final int WARN = 0xFFFFAC91;
    private static final int TRACK = 0xFF344542;
    private static final int SLOT = 18;
    private static final int TRAY_WIDTH = 213;
    private static final int BACKPACK_HEIGHT = 71;
    private static final float HUD_SCALE = 0.66F;
    private static final int VANILLA_BOTTOM_MARGIN = 29;
    private static final NumberFormat NUMBERS = NumberFormat.getIntegerInstance(Locale.US);
    private static boolean expanded;
    private static boolean detailsKeyDown;
    private static boolean renderedItems;
    private static ObserverFrame.Inventory cachedInventory;
    private static List<ItemStack> backpack = List.of(), hotbar = List.of(), armor = List.of();
    private static ItemStack offhand = ItemStack.EMPTY;

    private ObserverHud() {}

    public static void tick(Minecraft minecraft) {
        boolean pressed = minecraft.level != null && minecraft.screen == null
            && InputConstants.isKeyDown(minecraft.getWindow(), GLFW.GLFW_KEY_K);
        if (pressed && !detailsKeyDown) expanded = !expanded;
        detailsKeyDown = pressed;
    }

    public static void render(Minecraft minecraft, GuiGraphicsExtractor gui) {
        if (minecraft.level == null || minecraft.player == null || minecraft.screen != null || minecraft.options.hideGui) return;
        float scale = Math.max(HUD_SCALE, 1.0F / minecraft.getWindow().getGuiScale());
        int width = (int) (gui.guiWidth() / scale);
        int height = (int) (gui.guiHeight() / scale);
        int aboveXp = (int) ((gui.guiHeight() - VANILLA_BOTTOM_MARGIN) / scale);
        gui.pose().pushMatrix();
        try {
            gui.pose().scale(scale);
            drawHud(gui, minecraft.font, width, height, aboveXp);
        } finally {
            gui.pose().popMatrix();
        }
    }

    private static void drawHud(GuiGraphicsExtractor gui, Font font, int width, int height, int aboveXp) {
        ObserverFrame frame = AgentObserverClient.frame();
        drawVitals(gui, font, frame);
        if (frame.inventory() == null) return;

        int trayX = (width - TRAY_WIDTH) / 2;
        int trayY = aboveXp - BACKPACK_HEIGHT;
        boolean backpackVisible = trayX >= 4 && trayY >= 67;
        if (trayX >= 4 && aboveXp >= 86) {
            updateStacks(frame.inventory());
            if (backpackVisible) drawInventory(gui, font, trayX, trayY);
            drawHotbar(gui, font, frame.inventory(), trayX, height - SLOT - 4);
        }
        drawDecision(gui, font, frame, width, aboveXp, backpackVisible ? trayX + TRAY_WIDTH : -1, trayY);
    }

    private static void drawVitals(GuiGraphicsExtractor gui, Font font, ObserverFrame frame) {
        int x = 7, y = 7, w = 116;
        boolean connected = frame.inventory() != null;
        panel(gui, x, y, w, connected ? 58 : 29);
        gui.text(font, fit(font, frame.username(), w - (connected ? 36 : 12)), x + 6, y + 5, FG);
        if (!connected) {
            gui.text(font, frame.connection(), x + 6, y + 16, MUTED);
            return;
        }
        right(gui, font, frame.connection(), x + w - 6, y + 5, GOOD);
        metric(gui, font, "生命", points(frame.health()), frame.health(), x + 6, y + 17, w - 12,
            frame.health() <= 8 ? WARN : GOOD);
        metric(gui, font, "饱食", frame.food() + " / 20", frame.food(), x + 6, y + 31, w - 12,
            frame.foodRecovery() ? WARN : 0xFFDEB36C);
        gui.text(font, "背包空位", x + 6, y + 46, MUTED);
        right(gui, font, frame.freeSlots() + " / 36", x + w - 6, y + 46, frame.freeSlots() == 0 ? WARN : FG);
    }

    private static String points(double health) {
        return String.format(Locale.ROOT, "%.1f / 20", health).replace(".0 /", " / ");
    }

    private static void metric(GuiGraphicsExtractor gui, Font font, String label, String value, double amount,
                               int x, int y, int width, int color) {
        gui.text(font, label, x, y, MUTED);
        right(gui, font, value, x + width, y, FG);
        gui.fill(x, y + 9, x + width, y + 11, TRACK);
        int end = x + (int) Math.round(width * Math.clamp(amount / 20.0, 0, 1));
        if (end > x) gui.fill(x, y + 9, end, y + 11, color);
    }

    private static void drawInventory(GuiGraphicsExtractor gui, Font font, int x, int y) {
        gui.text(font, "Bot 背包", x + 7, y + 4, FG);
        right(gui, font, "实时", x + TRAY_WIDTH - 7, y + 4, GOOD);
        int gridX = x + 25, gridY = y + 14;
        for (int i = 0; i < backpack.size(); i++) {
            drawSlot(gui, font, backpack.get(i), gridX + i % 9 * SLOT, gridY + i / 9 * SLOT, false);
        }
        for (int i = 0; i < armor.size() - 1; i++) drawSlot(gui, font, armor.get(i), x + 5, gridY + i * SLOT, false);
        if (!renderedItems && (backpack.stream().anyMatch(stack -> !stack.isEmpty()) || hotbar.stream().anyMatch(stack -> !stack.isEmpty()))) {
            renderedItems = true;
            System.out.println("观察者已绘制 Bot 背包物品");
        }
    }

    private static void drawHotbar(GuiGraphicsExtractor gui, Font font, ObserverFrame.Inventory inventory, int x, int y) {
        for (int i = 0; i < hotbar.size(); i++) drawSlot(gui, font, hotbar.get(i), x + 25 + i * SLOT, y, i == inventory.selected());
        drawSlot(gui, font, armor.get(3), x + 5, y, false);
        drawSlot(gui, font, offhand, x + 25 + 9 * SLOT + 2, y, false);
    }

    private static void updateStacks(ObserverFrame.Inventory inventory) {
        if (inventory.equals(cachedInventory)) return;
        backpack = inventory.backpack().stream().map(ObserverHud::itemStack).toList();
        hotbar = inventory.hotbar().stream().map(ObserverHud::itemStack).toList();
        armor = inventory.armor().stream().map(ObserverHud::itemStack).toList();
        offhand = itemStack(inventory.offhand());
        cachedInventory = inventory;
    }

    private static ItemStack itemStack(ObserverFrame.Slot slot) {
        if (slot.count() <= 0) return ItemStack.EMPTY;
        Identifier id = Identifier.tryParse(slot.id());
        if (id == null) return ItemStack.EMPTY;
        ItemStack stack = new ItemStack(BuiltInRegistries.ITEM.getValue(id), slot.count());
        if (stack.isDamageableItem()) stack.setDamageValue(Math.clamp(slot.damage(), 0, stack.getMaxDamage()));
        if (slot.enchanted()) stack.set(DataComponents.ENCHANTMENT_GLINT_OVERRIDE, true);
        return stack;
    }

    private static void drawSlot(GuiGraphicsExtractor gui, Font font, ItemStack stack, int x, int y, boolean selected) {
        int border = selected ? GOOD : 0x78728781;
        gui.fill(x, y, x + 17, y + 1, border);
        gui.fill(x, y + 16, x + 17, y + 17, border);
        gui.fill(x, y + 1, x + 1, y + 16, border);
        gui.fill(x + 16, y + 1, x + 17, y + 16, border);
        if (stack.isEmpty()) return;
        gui.fakeItem(stack, x, y);
        gui.itemDecorations(font, stack, x, y);
    }

    private static void drawDecision(GuiGraphicsExtractor gui, Font font, ObserverFrame frame,
                                     int width, int bottom, int trayRight, int trayY) {
        int w = Math.min(164, width - 132);
        if (w < 99) return;
        int x = width - w - 7;
        String reason = frame.foodRecovery() ? "先补充食物，再返回原采矿目标。" :
            frame.freeSlots() == 0 ? "背包已满，优先腾出拾取空间。" : frame.reason();
        if (reason.isEmpty()) reason = frame.modelEnabled() ? "等待模型决策" : "本地策略执行中";
        var lines = font.split(Component.literal(reason), w - 12);
        int shownLines = Math.min(lines.size(), 2);
        int h = 43 + shownLines * 9 + (expanded ? 46 : 0);
        int floor = trayRight > x - 5 ? trayY - 5 : bottom;
        int y = Math.max(7, floor - h);
        panel(gui, x, y, w, h);
        String action = frame.foodRecovery() ? "补给中" : AgentObserverClient.actionZh(frame.action());
        if (frame.shieldRaised()) action += " · 举盾";
        gui.text(font, fit(font, action, w - 12), x + 6, y + 5, frame.foodRecovery() ? WARN : FG);
        ObserverFrame.Point goal = frame.mineTarget() != null ? frame.mineTarget() :
            frame.committedTarget() != null ? frame.committedTarget() : frame.target();
        String name = goal == null ? frame.mineOrder() : goal.name().isEmpty() ? frame.mineOrder() : goal.name();
        String target = name.isEmpty() && goal == null ? "目标 —" : "目标 " + (name.isEmpty() ? "" : AgentObserverClient.blockNameZh(name) + " ")
            + (goal == null ? "" : goal.coordinates());
        gui.text(font, fit(font, target, w - 12), x + 6, y + 17, GOOD);
        for (int i = 0; i < shownLines; i++) gui.text(font, lines.get(i), x + 6, y + 29 + i * 9, MUTED);
        int row = y + 29 + shownLines * 9;
        if (expanded) {
            gui.text(font, fit(font, "模型 " + (frame.modelEnabled() ? AgentObserverClient.actionZh(frame.modelAction()) : "已关闭"), w - 12), x + 6, row, FG);
            gui.text(font, fit(font, actualAction(frame), w - 12), x + 6, row + 9, FG);
            String position = frame.position() == null ? "—" : frame.position().coordinates();
            gui.text(font, "坐标 " + position, x + 6, row + 18, MUTED);
            String call = "入 " + format(frame.inputTokens()) + "  出 " + format(frame.outputTokens());
            gui.text(font, fit(font, call, w - 12), x + 6, row + 27, MUTED);
            gui.text(font, "累计 Token " + NUMBERS.format(frame.totalTokens()), x + 6, row + 36, MUTED);
            row += 46;
        }
        gui.text(font, expanded ? "K 收起" : "K 决策与 Token", x + 6, row + 2, GOOD);
    }

    private static String actualAction(ObserverFrame frame) {
        if (frame.actual() == null || frame.foodRecovery()) return "执行 " + AgentObserverClient.actionZh(frame.action());
        String block = AgentObserverClient.blockNameZh(frame.actual().name());
        return switch (frame.mineResult()) {
            case "path-clearance" -> "执行 清障 · " + block;
            case "target-mined" -> "执行 已挖 · " + block;
            case "unexpected-ore" -> "执行 拦截非目标 · " + block;
            default -> "执行 " + AgentObserverClient.actionZh(frame.action());
        };
    }

    private static String format(Long number) {
        return number == null ? "—" : NUMBERS.format(number);
    }

    private static String fit(Font font, String text, int width) {
        return font.width(text) <= width ? text : font.plainSubstrByWidth(text, width - font.width("…")) + "…";
    }

    private static void right(GuiGraphicsExtractor gui, Font font, String value, int x, int y, int color) {
        gui.text(font, value, x - font.width(value), y, color);
    }

    private static void panel(GuiGraphicsExtractor gui, int x, int y, int w, int h) {
        gui.fill(x, y, x + w, y + h, BORDER);
        gui.fill(x + 1, y + 1, x + w - 1, y + h - 1, PANEL);
    }
}
