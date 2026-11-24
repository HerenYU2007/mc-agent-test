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

final class ObserverTelemetry {
    private static final long DELAYED_AFTER_MS = 1000;
    private static final long EXPIRE_AFTER_MS = 4000;
    private record Cached(ObserverFrame frame, long receivedNs, long sourceAgeMs, boolean interrupted) {}
    record Snapshot(ObserverFrame frame, boolean delayed) {}
    private static final AtomicReference<Cached> CACHE = new AtomicReference<>(
        new Cached(ObserverFrame.disconnected("正在连接"), System.nanoTime(), 0, false));
    private static final URI STATE_ENDPOINT = URI.create(
        "http://127.0.0.1:" + Integer.getInteger("nmo.observer.port", 3001) + "/observer");
    private static final ScheduledExecutorService EXECUTOR = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "agent-observer-poll");
        t.setDaemon(true);
        return t;
    });
    private static final HttpClient HTTP = HttpClient.newBuilder()
        .connectTimeout(Duration.ofMillis(700))
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
            case "build-camp", "build_camp" -> "建造补给站";
            case "build-structure" -> "按蓝图建造";
            case "supply-base" -> "建设补给基地";
            case "inspect-stone", "inspect_stone" -> "查看石头";
            case "digging" -> "正在挖掘";
            case "boot", "-" -> "等待";
            default -> id;
        };
    }


    static void start() {
        System.out.println("观察者 HUD 已启动，状态地址：" + STATE_ENDPOINT);
        EXECUTOR.scheduleWithFixedDelay(ObserverTelemetry::poll, 0, 200, TimeUnit.MILLISECONDS);
    }

    private static void poll() {
        try {
            HttpRequest request = HttpRequest.newBuilder(STATE_ENDPOINT).timeout(Duration.ofMillis(850)).GET().build();
            HttpResponse<String> response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                interrupted("面板不可用");
                return;
            }
            ObserverFrame frame = ObserverFrame.read(JsonParser.parseString(response.body()).getAsJsonObject());
            Cached previous = CACHE.get();
            if (frame.inventory() == null && previous.frame().inventory() != null &&
                frame.username().equals(previous.frame().username())) {
                interrupted(frame.connection());
                return;
            }
            long sourceAge = frame.sampledAt() == null ? 0 : Math.max(0, System.currentTimeMillis() - frame.sampledAt());
            CACHE.set(new Cached(frame, System.nanoTime(), sourceAge, false));
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        } catch (Exception error) {
            interrupted("面板不可用");
        }
    }

    private static void interrupted(String message) {
        CACHE.updateAndGet(cached -> cached.frame().inventory() == null
            ? new Cached(ObserverFrame.disconnected(cached.frame().username(), message), System.nanoTime(), 0, true)
            : new Cached(cached.frame(), cached.receivedNs(), cached.sourceAgeMs(), true));
    }

    static Snapshot snapshot() {
        Cached cached = CACHE.get();
        ObserverFrame frame = cached.frame();
        if (frame.inventory() == null) return new Snapshot(frame, false);
        long age = cached.sourceAgeMs() + TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - cached.receivedNs());
        if (age > EXPIRE_AFTER_MS) return new Snapshot(ObserverFrame.disconnected(frame.username(), "遥测中断"), false);
        return new Snapshot(frame, cached.interrupted() || age > DELAYED_AFTER_MS);
    }

    static ObserverFrame frame() {
        return snapshot().frame();
    }
}
