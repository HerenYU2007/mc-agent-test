package com.nmo.agentobserver;

import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import com.nmo.agentobserver.ObserverSettings12111.Display;

final class ObserverSettingsScreen12111 extends Screen {
    private final ObserverSettings12111 settings;
    private boolean writeFailed;

    ObserverSettingsScreen12111(ObserverSettings12111 settings) {
        super(Component.literal("旁观者显示设置"));
        this.settings = settings;
    }

    @Override
    protected void init() {
        int widthPerButton = Math.min(196, (width - 18) / 2);
        int left = (width - widthPerButton * 2 - 8) / 2;
        int top = Math.max(44, (height - 110) / 2);
        Display[] displays = Display.values();
        for (int index = 0; index < displays.length; index++) {
            Display display = displays[index];
            int x = left + (index % 2) * (widthPerButton + 8);
            int y = top + (index / 2) * 24;
            addRenderableWidget(Button.builder(label(display), button -> {
                writeFailed = !settings.toggle(display);
                button.setMessage(label(display));
            }).bounds(x, y, widthPerButton, 20).build());
        }
        int doneWidth = Math.min(132, widthPerButton);
        addRenderableWidget(Button.builder(Component.literal("完成"), button -> onClose())
            .bounds((width - doneWidth) / 2, top + 103, doneWidth, 20).build());
    }

    private Component label(Display display) {
        return Component.literal(display.label + " · " + (settings.enabled(display) ? "开启" : "关闭"));
    }

    @Override
    public void render(GuiGraphics gui, int mouseX, int mouseY, float delta) {
        renderBackground(gui, mouseX, mouseY, delta);
        super.render(gui, mouseX, mouseY, delta);
        int top = Math.max(44, (height - 110) / 2);
        gui.drawCenteredString(font, title, width / 2, top - 31, 0xFFFFFFFF);
        String help = writeFailed ? "本次设置未能写入配置文件" : "单人实线为原版边界 · 联机虚线为观察估算";
        gui.drawCenteredString(font, help, width / 2, top - 15, writeFailed ? 0xFFFFAB9C : 0xFFC7DDD7);
    }

    @Override
    public boolean isPauseScreen() { return false; }
}
