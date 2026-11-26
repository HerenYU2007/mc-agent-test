package com.nmo.agentobserver;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.EnumMap;
import java.util.Locale;
import net.fabricmc.loader.api.FabricLoader;
import org.slf4j.LoggerFactory;

final class ObserverSettings12111 {
    enum Display {
        STRUCTURES("结构范围", true),
        STRUCTURE_PIECES("结构部件范围（单人）", false),
        ROUTE("Bot 路线与目标", true),
        STATUS("Bot 状态与决策", true),
        INVENTORY("Bot 背包与装备", true),
        SCAN_INFO("巡航与扫描提示", true),
        NIGHT_VISION("客户端夜视", true);

        final String label;
        final boolean enabledByDefault;

        Display(String label, boolean enabledByDefault) {
            this.label = label;
            this.enabledByDefault = enabledByDefault;
        }

        String key() { return name().toLowerCase(Locale.ROOT); }
    }

    private static final org.slf4j.Logger LOG = LoggerFactory.getLogger("nmo-observer-settings");
    private final EnumMap<Display, Boolean> values = new EnumMap<>(Display.class);
    private final Path file;

    ObserverSettings12111() {
        this(FabricLoader.getInstance().getConfigDir().resolve("nmo-observer-display.json"));
    }

    ObserverSettings12111(Path file) {
        this.file = file;
        for (Display display : Display.values()) values.put(display, display.enabledByDefault);
        if (!Files.isRegularFile(file)) return;
        try (var input = Files.newBufferedReader(file)) {
            JsonObject json = JsonParser.parseReader(input).getAsJsonObject();
            for (Display display : Display.values()) {
                var value = json.get(display.key());
                if (value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isBoolean()) {
                    values.put(display, value.getAsBoolean());
                }
            }
        } catch (IOException | RuntimeException error) {
            LOG.warn("无法读取旁观者显示设置", error);
        }
    }

    boolean enabled(Display display) { return values.get(display); }

    boolean toggle(Display display) {
        values.put(display, !enabled(display));
        try {
            save();
            return true;
        } catch (IOException error) {
            LOG.warn("无法保存旁观者显示设置", error);
            return false;
        }
    }

    private void save() throws IOException {
        JsonObject json = new JsonObject();
        values.forEach((display, enabled) -> json.addProperty(display.key(), enabled));
        Files.createDirectories(file.getParent());
        Path temp = Files.createTempFile(file.getParent(), "nmo-observer-display-", ".tmp");
        try {
            Files.writeString(temp, new GsonBuilder().setPrettyPrinting().create().toJson(json) + "\n");
            try {
                Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException unsupported) {
                Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temp);
        }
    }
}
