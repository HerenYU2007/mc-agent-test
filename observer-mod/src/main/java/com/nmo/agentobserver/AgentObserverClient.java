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
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.api.ClientModInitializer;
import net.minecraft.client.Minecraft;
import net.minecraft.gizmos.Gizmos;
import net.minecraft.gizmos.GizmoStyle;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

public final class AgentObserverClient implements ClientModInitializer {
    private static final AtomicReference<String> OVERLAY = new AtomicReference<>("观察者：正在连接…");
    private static final URI STATE_ENDPOINT = URI.create(
        "http://127.0.0.1:" + Integer.getInteger("nmo.observer.port", 3001) + "/state");
    private static final ScheduledExecutorService EXECUTOR = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "agent-observer-poll");
        t.setDaemon(true);
        return t;
    });
    private static final HttpClient HTTP = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(2))
        .build();
    private static volatile List<PathPoint> WAYPOINTS = List.of();
    private static volatile TargetPoint TARGET = null;
    private static volatile MineTarget MINE_TARGET = null;
    private static volatile Point3 AGENT_POSITION = null;
    private static int renderTick;
    private static boolean renderedPath;
    private static boolean receivedDecision;

    private record PathPoint(double x, double y, double z) {}
    private record TargetPoint(int x, Integer y, int z) {}
    private record Point3(int x, int y, int z) {}
    private record MineTarget(int x, int y, int z, String name) {}

    private static String blockNameZh(String id) {
        if (id == null) return "未知方块";
        return switch (id) {
            case "stone" -> "石头";
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

    private static String actionZh(String id) {
        if (id == null) return "-";
        return switch (id) {
            case "mine" -> "挖矿";
            case "gather-stone-for-tools" -> "采集石头";
            case "gather-coal-for-torches" -> "采集煤炭";
            case "gather-coal-for-smelting" -> "为冶炼找煤";
            case "furnace-recovery" -> "回收熔炉";
            case "night-shelter" -> "夜间避难";
            case "death-recovery" -> "回收死亡掉落物";
            case "hunt-food", "hunt_food" -> "寻找食物";
            case "collect-wood", "collect_wood" -> "采木";
            case "gear-up", "gear_up" -> "合成装备";
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

    @Override
    public void onInitializeClient() {
        System.out.println("观察者已启动，状态地址：" + STATE_ENDPOINT);
        EXECUTOR.scheduleAtFixedRate(AgentObserverClient::poll, 0, 500, TimeUnit.MILLISECONDS);
    }

    private static void poll() {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                .uri(STATE_ENDPOINT)
                .timeout(Duration.ofSeconds(2))
                .GET()
                .build();
            String json = HTTP.send(request, HttpResponse.BodyHandlers.ofString()).body();
            JsonObject state = JsonParser.parseString(json).getAsJsonObject();
            String action = value(json, "decision");
            JsonObject model = state.has("lastModelDecision") && state.get("lastModelDecision").isJsonObject()
                ? state.getAsJsonObject("lastModelDecision") : null;
            String modelAction = model == null || !model.has("action") ? "-" : model.get("action").getAsString();
            String reason = model == null || !model.has("reason") ? "" : model.get("reason").getAsString().strip();
            if (reason.length() > 35) reason = reason.substring(0, 35) + "…";
            if (model != null && !receivedDecision) {
                receivedDecision = true;
                System.out.println("观察者收到模型决策：" + actionZh(modelAction));
            }
            String health = value(json, "health");
            JsonObject combat = state.has("lastCombatDecision") && state.get("lastCombatDecision").isJsonObject()
                ? state.getAsJsonObject("lastCombatDecision") : null;
            parseAgentPosition(json);
            parseNavigation(json);
            TargetPoint currentTarget = TARGET;
            String target = currentTarget == null ? "-" : currentTarget.x + "," +
                (currentTarget.y == null ? "" : currentTarget.y + ",") + currentTarget.z;
            parseMineTarget(json);
            String connection = json.contains("\"botConnected\":true") ? "已连接" : "未连接";
            MineTarget mine = MINE_TARGET;
            String doing = mine != null
                ? "准备挖 " + blockNameZh(mine.name) + " (" + mine.x + "," + mine.y + "," + mine.z + ")"
                : actionZh(action);
            if (!"已连接".equals(connection)) {
                AGENT_POSITION = null;
                WAYPOINTS = List.of();
                TARGET = null;
                MINE_TARGET = null;
                OVERLAY.set("智能体未连接");
            } else {
                String why = combat != null && combat.has("reason") ? combat.get("reason").getAsString() : reason;
                boolean shield = state.has("shieldRaised") && state.get("shieldRaised").getAsBoolean();
                OVERLAY.set((shield ? "【举盾】 " : "") + "行动：" + doing + " | 模型：" + actionZh(modelAction)
                    + (why.isEmpty() ? "" : " | " + why)
                    + " | 目标：" + target + " | 生命：" + health);
            }
        } catch (Exception e) {
            WAYPOINTS = List.of();
            TARGET = null;
            MINE_TARGET = null;
            AGENT_POSITION = null;
            OVERLAY.set("观察者：无法连接控制面板");
        }
    }

    private static void parseNavigation(String json) {
        List<PathPoint> points = new ArrayList<>();
        int navigation = json.indexOf("\"navigation\":{");
        int waypoints = navigation >= 0 ? json.indexOf("\"waypoints\":[", navigation) : -1;
        if (waypoints >= 0) {
            int end = json.indexOf(']', waypoints);
            if (end > waypoints) {
                String section = json.substring(waypoints, end);
                String number = "(-?\\d+(?:\\.\\d+)?)";
                Matcher matcher3 = Pattern.compile("\\{\\\"x\\\":" + number + ",\\\"y\\\":" + number + ",\\\"z\\\":" + number + "\\}").matcher(section);
                while (matcher3.find()) points.add(new PathPoint(Double.parseDouble(matcher3.group(1)), Double.parseDouble(matcher3.group(2)), Double.parseDouble(matcher3.group(3))));
                if (points.isEmpty()) {
                    Matcher matcher2 = Pattern.compile("\\{\\\"x\\\":" + number + ",\\\"z\\\":" + number + "\\}").matcher(section);
                    while (matcher2.find()) points.add(new PathPoint(Double.parseDouble(matcher2.group(1)), AGENT_POSITION == null ? 0 : AGENT_POSITION.y, Double.parseDouble(matcher2.group(2))));
                }
            }
        }
        WAYPOINTS = List.copyOf(points);
        // Only use navigation.target. The dashboard also contains model and
        // entity targets; parsing the first generic target made old model
        // coordinates remain outlined after a path had ended.
        TARGET = null;
        int target = navigation >= 0 ? json.indexOf("\"target\":{", navigation) : -1;
        if (target >= 0 && target < waypoints) {
            int end = json.indexOf('}', target);
            if (end > target) {
                String object = json.substring(target, end + 1);
                String x = value(object, "x");
                String z = value(object, "z");
                String y = value(object, "y");
                try {
                    TARGET = new TargetPoint(Integer.parseInt(x), y.equals("-") ? null : Integer.parseInt(y), Integer.parseInt(z));
                } catch (NumberFormatException ignored) { TARGET = null; }
            }
        }
    }

    private static void parseMineTarget(String json) {
        MINE_TARGET = null;
        int mine = json.indexOf("\"mine\":{");
        if (mine < 0) return;
        // mine is a flat object whose only nested object is target, so its end
        // is the first "}}" after the key (or "}" when target is null).
        int target = json.indexOf("\"target\":", mine);
        if (target < 0) return;
        int valueStart = target + "\"target\":".length();
        if (valueStart >= json.length() || json.charAt(valueStart) != '{') return;
        int end = json.indexOf('}', valueStart);
        if (end < 0) return;
        String object = json.substring(valueStart, end + 1);
        try {
            MINE_TARGET = new MineTarget(Integer.parseInt(value(object, "x")), Integer.parseInt(value(object, "y")),
                Integer.parseInt(value(object, "z")), value(object, "name"));
        } catch (NumberFormatException ignored) {
            MINE_TARGET = null;
        }
    }

    private static void parseAgentPosition(String json) {
        int position = json.indexOf("\"position\":{");
        if (position < 0) return;
        int end = json.indexOf('}', position);
        if (end < 0) return;
        String object = json.substring(position, end + 1);
        try {
            AGENT_POSITION = new Point3(Integer.parseInt(value(object, "x")), Integer.parseInt(value(object, "y")), Integer.parseInt(value(object, "z")));
        } catch (NumberFormatException ignored) {
            AGENT_POSITION = null;
        }
    }

    public static void renderPathLines(Minecraft minecraft) {
        if (minecraft.level == null || (++renderTick % 2) != 0 || AGENT_POSITION == null) return;
        List<PathPoint> waypoints = WAYPOINTS;
        if (!renderedPath && !waypoints.isEmpty()) {
            renderedPath = true;
            System.out.println("观察者已绘制实际路径，节点数：" + waypoints.size());
        }
        TargetPoint targetPoint = TARGET;
        MineTarget mineTarget = MINE_TARGET;
        try (Gizmos.TemporaryCollection ignored = minecraft.collectPerTickGizmos()) {
            if (mineTarget != null) {
                Gizmos.cuboid(new AABB(mineTarget.x, mineTarget.y, mineTarget.z,
                    mineTarget.x + 1, mineTarget.y + 1, mineTarget.z + 1), GizmoStyle.stroke(0xFF20FF20, 4.0F))
                    .setAlwaysOnTop()
                    .persistForMillis(120);
            }
            Vec3 previous = new Vec3(AGENT_POSITION.x + 0.5, AGENT_POSITION.y + 0.15, AGENT_POSITION.z + 0.5);
            for (PathPoint point : waypoints) {
                Vec3 next = new Vec3(point.x, point.y + 0.15, point.z);
                Gizmos.line(previous, next, 0xFFFF2020, 4.0F)
                    .setAlwaysOnTop()
                    .persistForMillis(120);
                previous = next;
            }
            if (targetPoint != null) {
                int y = targetPoint.y == null
                    ? (waypoints.isEmpty() ? AGENT_POSITION.y : (int)Math.floor(previous.y))
                    : targetPoint.y;
                Gizmos.cuboid(new AABB(targetPoint.x, y, targetPoint.z,
                    targetPoint.x + 1, y + 1, targetPoint.z + 1), GizmoStyle.stroke(0xFFFF2020, 4.0F))
                    .setAlwaysOnTop()
                    .persistForMillis(120);
            }
        }
    }

    private static String value(String json, String key) {
        String needle = "\"" + key + "\":";
        int start = json.indexOf(needle);
        if (start < 0) return "-";
        start += needle.length();
        while (start < json.length() && Character.isWhitespace(json.charAt(start))) start++;
        if (start < json.length() && json.charAt(start) == '"') {
            int end = json.indexOf('"', start + 1);
            return end > start ? json.substring(start + 1, end) : "-";
        }
        int end = start;
        while (end < json.length() && ",}".indexOf(json.charAt(end)) < 0) end++;
        return json.substring(start, end).trim();
    }

    public static String overlay() {
        return OVERLAY.get();
    }
}
