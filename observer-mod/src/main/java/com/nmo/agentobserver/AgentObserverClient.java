package com.nmo.agentobserver;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import com.google.gson.JsonParser;
import net.fabricmc.api.ClientModInitializer;
import net.minecraft.client.Minecraft;
import net.minecraft.gizmos.Gizmos;
import net.minecraft.gizmos.GizmoStyle;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

public final class AgentObserverClient implements ClientModInitializer {
    private static final AtomicReference<ObserverFrame> FRAME = new AtomicReference<>(ObserverFrame.disconnected("正在连接"));
    private static final URI STATE_ENDPOINT = URI.create(
        "http://127.0.0.1:" + Integer.getInteger("nmo.observer.port", 3001) + "/observer");
    private static final ScheduledExecutorService EXECUTOR = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "agent-observer-poll");
        t.setDaemon(true);
        return t;
    });
    private static final HttpClient HTTP = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(2))
        .build();
    static String blockNameZh(String id) {
        if (id == null || id.isEmpty()) return "未知方块";
        return switch (id) {
            case "stone" -> "石头";
            case "diamond" -> "钻石";
            case "iron" -> "铁矿";
            case "coal" -> "煤矿";
            case "deepslate" -> "深板岩";
            case "cobblestone" -> "圆石";
            case "coal_ore" -> "煤矿";
            case "deepslate_coal_ore" -> "深层煤矿";
            case "iron_ore" -> "铁矿";
            case "deepslate_iron_ore" -> "深层铁矿";
            case "copper_ore" -> "铜矿";
            case "deepslate_copper_ore" -> "深层铜矿";
            case "gold_ore" -> "金矿";
            case "deepslate_gold_ore" -> "深层金矿";
            case "redstone_ore" -> "红石矿";
            case "deepslate_redstone_ore" -> "深层红石矿";
            case "lapis_ore" -> "青金石矿";
            case "deepslate_lapis_ore" -> "深层青金石矿";
            case "diamond_ore" -> "钻石矿";
            case "deepslate_diamond_ore" -> "深层钻石矿";
            case "emerald_ore" -> "绿宝石矿";
            case "deepslate_emerald_ore" -> "深层绿宝石矿";
            case "oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log" -> "原木";
            case "dirt" -> "泥土";
            default -> id;
        };
    }

    static String actionZh(String id) {
        if (id == null || id.isEmpty()) return "-";
        return switch (id) {
            case "mine" -> "挖矿";
            case "gather-stone-for-tools" -> "采集石头";
            case "gather-coal-for-torches" -> "采集煤炭";
            case "gather-coal-for-smelting" -> "为冶炼找煤";
            case "furnace-recovery" -> "回收熔炉";
            case "night-shelter" -> "夜间避难";
            case "death-recovery" -> "回收死亡掉落物";
            case "hunt-food", "hunt_food" -> "寻找食物";
            case "surface-resupply" -> "返回地面补给";
            case "collect-wood", "collect_wood" -> "采木";
            case "gear-up", "gear_up" -> "合成装备";
            case "emergency-shelter" -> "紧急避难";
            case "flee" -> "撤退";
            case "attack", "hunt-hostile" -> "战斗";
            case "explore" -> "探索";
            case "swim-ashore" -> "游泳上岸";
            case "build-camp", "build_camp" -> "搭建营地";
            case "inspect-stone", "inspect_stone" -> "查看石头";
            case "digging" -> "正在挖掘";
            case "boot", "-" -> "等待";
            default -> id;
        };
    }


    private static int renderTick;

    @Override
    public void onInitializeClient() {
        System.out.println("观察者 HUD 已启动，状态地址：" + STATE_ENDPOINT);
        EXECUTOR.scheduleWithFixedDelay(AgentObserverClient::poll, 0, 500, TimeUnit.MILLISECONDS);
    }

    private static void poll() {
        try {
            HttpRequest request = HttpRequest.newBuilder(STATE_ENDPOINT).timeout(Duration.ofSeconds(2)).GET().build();
            HttpResponse<String> response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                FRAME.set(ObserverFrame.disconnected("面板不可用"));
                return;
            }
            FRAME.set(ObserverFrame.read(JsonParser.parseString(response.body()).getAsJsonObject()));
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        } catch (Exception error) {
            FRAME.set(ObserverFrame.disconnected("面板不可用"));
        }
    }

    static ObserverFrame frame() {
        return FRAME.get();
    }

    public static void renderPathLines(Minecraft minecraft) {
        ObserverFrame frame = frame();
        if (minecraft.level == null || (++renderTick % 2) != 0 || frame.position() == null) return;
        ObserverFrame.Point position = frame.position();
        if (position.y() == null) return;

        try (Gizmos.TemporaryCollection ignored = minecraft.collectPerTickGizmos()) {
            Vec3 previous = new Vec3(position.x() + 0.5, position.y() + 0.15, position.z() + 0.5);
            for (ObserverFrame.Point point : frame.waypoints()) {
                Vec3 next = new Vec3(point.x(), point.y() + 0.15, point.z());
                Gizmos.line(previous, next, 0xFFFF3030, 4.0F).setAlwaysOnTop().persistForMillis(120);
                previous = next;
            }
            ObserverFrame.Point target = frame.mineTarget() == null ? frame.target() : frame.mineTarget();
            if (target == null) return;
            double y = target.y() == null ? Math.floor(previous.y) : target.y();
            Gizmos.cuboid(new AABB(target.x(), y, target.z(), target.x() + 1, y + 1, target.z() + 1),
                GizmoStyle.stroke(0xFFFF3030, 4.0F)).setAlwaysOnTop().persistForMillis(120);
        }
    }
}
