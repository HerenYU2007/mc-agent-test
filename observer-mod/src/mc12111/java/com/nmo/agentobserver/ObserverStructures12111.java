package com.nmo.agentobserver;

import com.google.gson.Gson;
import com.mojang.blaze3d.platform.InputConstants;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.minecraft.client.Minecraft;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.chunk.status.ChunkStatus;
import net.minecraft.world.phys.AABB;
import org.lwjgl.glfw.GLFW;

final class ObserverStructures12111 {
    private static final int SEARCH_RADIUS = 3;
    private static final int CACHE_RADIUS = 8;
    private static final int BATCH_SIZE = 24;
    private static final long RETRY_MS = 2000L;
    private static final long RESCAN_MS = 45000L;
    private static final Gson JSON = new Gson();
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build();
    private static final URI ENDPOINT = URI.create("http://127.0.0.1:" +
        Integer.getInteger("nmo.structure.port", Integer.getInteger("nmo.observer.port", 3001)) + "/observer/structures");

    private enum Clue {
        BELL, BED, WORKSTATION, BLUE_TERRACOTTA, ORANGE_TERRACOTTA, SANDSTONE, TNT, MOSSY_COBBLESTONE,
        DISPENSER, TRIPWIRE_HOOK, PRISMARINE, DARK_PRISMARINE, SEA_LANTERN, NETHER_BRICKS, NETHER_BRICK_DETAIL,
        GILDED_BLACKSTONE, POLISHED_BLACKSTONE_BRICKS, PURPUR, END_STONE_BRICKS, CRYING_OBSIDIAN, NETHERRACK,
        TRIAL_SPAWNER, TRIAL_TUFF, COPPER_GRATE, REINFORCED_DEEPSLATE, SCULK, END_PORTAL_FRAME
    }

    private record Chunk(int x, int z) {}
    private record Evidence(int count, BlockPos first, AABB bounds) {}
    private record Observation(Map<Clue, Evidence> clues, long sampledAt) {}
    private record Report(String type, String world, String dimension, int[] pos, List<String> evidence) {}
    private record Upload(List<String> keys, CompletableFuture<Boolean> result) {}
    private record Rule(String type, String dimension, Clue anchor, Map<Clue, Integer> minimum) {}
    private record Estimate(BlockPos anchor, ObserverStructureOverlay12111.Outline outline, Map<Chunk, AABB> parts) {}
    private static final Clue[] CLUES = Clue.values();
    private static final List<Rule> RULES = List.of(
        new Rule("village", "overworld", Clue.BELL, Map.of(Clue.BELL, 1, Clue.BED, 2, Clue.WORKSTATION, 1)),
        new Rule("desert_pyramid", "overworld", Clue.BLUE_TERRACOTTA,
            Map.of(Clue.BLUE_TERRACOTTA, 1, Clue.ORANGE_TERRACOTTA, 4, Clue.SANDSTONE, 32, Clue.TNT, 4)),
        new Rule("jungle_temple", "overworld", Clue.DISPENSER,
            Map.of(Clue.DISPENSER, 2, Clue.MOSSY_COBBLESTONE, 24, Clue.TRIPWIRE_HOOK, 2)),
        new Rule("monument", "overworld", Clue.DARK_PRISMARINE,
            Map.of(Clue.DARK_PRISMARINE, 8, Clue.PRISMARINE, 32, Clue.SEA_LANTERN, 4)),
        new Rule("ruined_portal", "overworld", Clue.CRYING_OBSIDIAN,
            Map.of(Clue.CRYING_OBSIDIAN, 1, Clue.NETHERRACK, 6)),
        new Rule("trial_chambers", "overworld", Clue.TRIAL_SPAWNER,
            Map.of(Clue.TRIAL_SPAWNER, 1, Clue.TRIAL_TUFF, 16, Clue.COPPER_GRATE, 2)),
        new Rule("ancient_city", "overworld", Clue.REINFORCED_DEEPSLATE,
            Map.of(Clue.REINFORCED_DEEPSLATE, 4, Clue.SCULK, 8)),
        new Rule("fortress", "the_nether", Clue.NETHER_BRICKS,
            Map.of(Clue.NETHER_BRICKS, 80, Clue.NETHER_BRICK_DETAIL, 4)),
        new Rule("bastion", "the_nether", Clue.GILDED_BLACKSTONE,
            Map.of(Clue.GILDED_BLACKSTONE, 1, Clue.POLISHED_BLACKSTONE_BRICKS, 32)),
        new Rule("end_city", "the_end", Clue.PURPUR, Map.of(Clue.PURPUR, 24, Clue.END_STONE_BRICKS, 16))
    );

    private final Map<Block, Clue> known = new HashMap<>();
    private final Map<Chunk, Observation> cache = new HashMap<>();
    private final Map<String, Report> outbox = new LinkedHashMap<>();
    private final Map<String, Long> seen = new HashMap<>();
    private final Map<String, Estimate> estimates = new LinkedHashMap<>();
    private final ArrayDeque<Chunk> queue = new ArrayDeque<>();
    private ClientLevel level;
    private Chunk center;
    private Chunk scanning;
    private final int[] counts = new int[CLUES.length];
    private final BlockPos[] first = new BlockPos[CLUES.length];
    private final int[][] extents = new int[CLUES.length][6];
    private int sectionIndex;
    private String world;
    private String dimension;
    private long nextQueue;
    private long nextUpload;
    private Upload upload;
    private boolean flying;
    private boolean forwardHeld;
    private boolean f8Down;
    private int reported;

    void register(ObserverSettings12111 settings) {
        for (Block block : BuiltInRegistries.BLOCK) {
            if (block instanceof BedBlock) known.put(block, Clue.BED);
        }
        match(Clue.BELL, Blocks.BELL);
        match(Clue.WORKSTATION, Blocks.COMPOSTER, Blocks.LECTERN, Blocks.FLETCHING_TABLE, Blocks.CARTOGRAPHY_TABLE,
            Blocks.SMOKER, Blocks.BLAST_FURNACE, Blocks.STONECUTTER, Blocks.LOOM, Blocks.BREWING_STAND,
            Blocks.CAULDRON, Blocks.GRINDSTONE, Blocks.SMITHING_TABLE, Blocks.BARREL);
        match(Clue.BLUE_TERRACOTTA, Blocks.BLUE_TERRACOTTA);
        match(Clue.ORANGE_TERRACOTTA, Blocks.ORANGE_TERRACOTTA);
        match(Clue.SANDSTONE, Blocks.SANDSTONE, Blocks.CUT_SANDSTONE, Blocks.CHISELED_SANDSTONE);
        match(Clue.TNT, Blocks.TNT);
        match(Clue.MOSSY_COBBLESTONE, Blocks.MOSSY_COBBLESTONE);
        match(Clue.DISPENSER, Blocks.DISPENSER);
        match(Clue.TRIPWIRE_HOOK, Blocks.TRIPWIRE_HOOK);
        match(Clue.PRISMARINE, Blocks.PRISMARINE, Blocks.PRISMARINE_BRICKS);
        match(Clue.DARK_PRISMARINE, Blocks.DARK_PRISMARINE);
        match(Clue.SEA_LANTERN, Blocks.SEA_LANTERN);
        match(Clue.NETHER_BRICKS, Blocks.NETHER_BRICKS);
        match(Clue.NETHER_BRICK_DETAIL, Blocks.NETHER_BRICK_STAIRS, Blocks.NETHER_BRICK_FENCE);
        match(Clue.GILDED_BLACKSTONE, Blocks.GILDED_BLACKSTONE);
        match(Clue.POLISHED_BLACKSTONE_BRICKS, Blocks.POLISHED_BLACKSTONE_BRICKS);
        match(Clue.PURPUR, Blocks.PURPUR_BLOCK, Blocks.PURPUR_PILLAR);
        match(Clue.END_STONE_BRICKS, Blocks.END_STONE_BRICKS);
        match(Clue.CRYING_OBSIDIAN, Blocks.CRYING_OBSIDIAN);
        match(Clue.NETHERRACK, Blocks.NETHERRACK);
        match(Clue.TRIAL_SPAWNER, Blocks.TRIAL_SPAWNER);
        match(Clue.TRIAL_TUFF, Blocks.TUFF_BRICKS, Blocks.CHISELED_TUFF_BRICKS, Blocks.TUFF_BRICK_STAIRS);
        match(Clue.COPPER_GRATE, Blocks.COPPER_GRATE, Blocks.EXPOSED_COPPER_GRATE, Blocks.WEATHERED_COPPER_GRATE,
            Blocks.OXIDIZED_COPPER_GRATE, Blocks.WAXED_COPPER_GRATE, Blocks.WAXED_EXPOSED_COPPER_GRATE,
            Blocks.WAXED_WEATHERED_COPPER_GRATE, Blocks.WAXED_OXIDIZED_COPPER_GRATE);
        match(Clue.REINFORCED_DEEPSLATE, Blocks.REINFORCED_DEEPSLATE);
        match(Clue.SCULK, Blocks.SCULK, Blocks.SCULK_CATALYST, Blocks.SCULK_SHRIEKER);
        match(Clue.END_PORTAL_FRAME, Blocks.END_PORTAL_FRAME);
        ClientTickEvents.END_CLIENT_TICK.register(this::tick);
        HudElementRegistry.addLast(Identifier.fromNamespaceAndPath("nmo-observer-survey", "structures"), (gui, delta) -> {
            Minecraft mc = Minecraft.getInstance();
            if (!settings.enabled(ObserverSettings12111.Display.SCAN_INFO) ||
                mc.player == null || !mc.player.isSpectator() || mc.options.hideGui || mc.screen != null) return;
            String status = flying ? "F8 停止巡航" : "F8 水平巡航";
            gui.drawString(mc.font, status + " · 结构上报 " + reported + (outbox.isEmpty() ? "" : " · 待发 " + outbox.size()),
                6, gui.guiHeight() - 70, 0xFFAAEDDB, true);
        });
    }

    private void match(Clue clue, Block... blocks) {
        for (Block block : blocks) known.put(block, clue);
    }

    private void flight(Minecraft mc, boolean spectator, boolean changedWorld) {
        boolean down = spectator && InputConstants.isKeyDown(mc.getWindow(), GLFW.GLFW_KEY_F8);
        if (!spectator || changedWorld) flying = false;
        if (down && !f8Down && mc.screen == null && mc.isWindowActive()) flying = !flying;
        f8Down = down;
        boolean cruise = flying && mc.screen == null && mc.isWindowActive();
        if (cruise) {
            mc.player.setXRot(0);
            mc.options.keyUp.setDown(true);
        } else if (forwardHeld) {
            if (mc.isWindowActive() && mc.screen == null) KeyMapping.setAll();
            else mc.options.keyUp.setDown(false);
        }
        forwardHeld = cruise;
    }

    private void tick(Minecraft mc) {
        long now = System.currentTimeMillis();
        flush(now);
        boolean spectator = mc.player != null && mc.level != null && mc.player.isSpectator();
        flight(mc, spectator, level != mc.level);
        if (!spectator) {
            level = null;
            return;
        }
        if (level != mc.level) {
            level = mc.level;
            center = scanning = null;
            queue.clear();
            cache.clear();
            seen.clear();
            estimates.clear();
            dimension = level.dimension().identifier().getPath();
            String label = System.getProperty("nmo.structure.world", "").trim();
            var server = mc.getCurrentServer();
            var local = mc.getSingleplayerServer();
            world = server != null ? server.ip + (label.isEmpty() ? "" : "/" + label)
                : "本地/" + (label.isEmpty() ? (local == null ? "单人世界" : local.getWorldData().getLevelName()) : label);
        }
        ChunkPos pos = mc.player.chunkPosition();
        Chunk current = new Chunk(pos.x, pos.z);
        if (!current.equals(center) || (queue.isEmpty() && now >= nextQueue)) prepare(current, now);
        long deadline = System.nanoTime() + 1_500_000L;
        while (!queue.isEmpty() && System.nanoTime() < deadline) {
            Chunk posToScan = queue.peek();
            if (!posToScan.equals(scanning)) {
                scanning = posToScan;
                sectionIndex = 0;
                Arrays.fill(counts, 0);
            }
            LevelChunk chunk = level.getChunkSource().getChunk(scanning.x(), scanning.z(), ChunkStatus.FULL, false);
            if (chunk == null) {
                queue.remove();
                continue;
            }
            LevelChunkSection section = chunk.getSections()[sectionIndex];
            if (section.maybeHas(state -> known.containsKey(state.getBlock()))) {
                scanSection(chunk, section);
            }
            if (++sectionIndex == chunk.getSections().length) {
                Map<Clue, Evidence> found = new EnumMap<>(Clue.class);
                for (Clue clue : CLUES) {
                    int i = clue.ordinal();
                    if (counts[i] > 0) {
                        int[] e = extents[i];
                        found.put(clue, new Evidence(counts[i], first[i],
                            new AABB(e[0], e[1], e[2], e[3] + 1, e[4] + 1, e[5] + 1)));
                    }
                }
                cache.put(scanning, new Observation(found, now));
                for (int dz = -1; dz <= 1; dz++) for (int dx = -1; dx <= 1; dx++) {
                    recognize(new Chunk(scanning.x() + dx, scanning.z() + dz), now);
                }
                queue.remove();
                scanning = null;
            }
        }
    }

    private void prepare(Chunk current, long now) {
        center = current;
        scanning = null;
        nextQueue = now + 1200L;
        queue.clear();
        cache.keySet().removeIf(p -> Math.abs(p.x() - center.x()) > CACHE_RADIUS || Math.abs(p.z() - center.z()) > CACHE_RADIUS);
        estimates.values().removeIf(estimate -> Math.abs((estimate.anchor().getX() >> 4) - center.x()) > CACHE_RADIUS ||
            Math.abs((estimate.anchor().getZ() >> 4) - center.z()) > CACHE_RADIUS);
        seen.values().removeIf(last -> now - last > RESCAN_MS * 4);
        List<Chunk> near = new ArrayList<>();
        for (int dz = -SEARCH_RADIUS; dz <= SEARCH_RADIUS; dz++) for (int dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
            Chunk p = new Chunk(center.x() + dx, center.z() + dz);
            Observation old = cache.get(p);
            if (old == null || now - old.sampledAt() >= RESCAN_MS) near.add(p);
        }
        near.sort(Comparator.comparingInt(p -> Math.abs(p.x() - center.x()) + Math.abs(p.z() - center.z())));
        queue.addAll(near);
    }

    private void scanSection(LevelChunk chunk, LevelChunkSection section) {
        int baseY = chunk.getSectionYFromSectionIndex(sectionIndex) * 16;
        ChunkPos pos = chunk.getPos();
        for (int y = 0; y < 16; y++) for (int z = 0; z < 16; z++) for (int x = 0; x < 16; x++) {
            Clue clue = known.get(section.getBlockState(x, y, z).getBlock());
            if (clue == null) continue;
            int i = clue.ordinal();
            int bx = pos.getMinBlockX() + x, by = baseY + y, bz = pos.getMinBlockZ() + z;
            int[] extent = extents[i];
            if (counts[i]++ == 0) {
                first[i] = new BlockPos(bx, by, bz);
                extent[0] = extent[3] = bx;
                extent[1] = extent[4] = by;
                extent[2] = extent[5] = bz;
            } else {
                extent[0] = Math.min(extent[0], bx);
                extent[1] = Math.min(extent[1], by);
                extent[2] = Math.min(extent[2], bz);
                extent[3] = Math.max(extent[3], bx);
                extent[4] = Math.max(extent[4], by);
                extent[5] = Math.max(extent[5], bz);
            }
        }
    }

    private void recognize(Chunk anchor, long now) {
        Observation observation = cache.get(anchor);
        if (observation == null || observation.clues().isEmpty()) return;
        Map<Clue, Integer> nearby = new EnumMap<>(Clue.class);
        Map<Chunk, Observation> neighbors = new LinkedHashMap<>();
        for (int dz = -1; dz <= 1; dz++) for (int dx = -1; dx <= 1; dx++) {
            Chunk chunk = new Chunk(anchor.x() + dx, anchor.z() + dz);
            Observation next = cache.get(chunk);
            if (next != null && now - next.sampledAt() < RESCAN_MS * 2) {
                neighbors.put(chunk, next);
                next.clues().forEach((clue, evidence) -> nearby.merge(clue, evidence.count(), Integer::sum));
            }
        }
        Evidence frame = observation.clues().get(Clue.END_PORTAL_FRAME);
        if ("overworld".equals(dimension) && frame != null) {
            BlockPos portal = endPortalCenter(frame.first());
            if (portal != null) {
                AABB bounds = new AABB(portal.getX() - 2, portal.getY() - 1, portal.getZ() - 2,
                    portal.getX() + 3, portal.getY() + 2, portal.getZ() + 3);
                estimates.put("end_portal/" + portal.asLong(), new Estimate(portal,
                    new ObserverStructureOverlay12111.Outline("end_portal", bounds, List.of(bounds), false), Map.of()));
                found("end_portal", portal, List.of("end_portal_frame", "complete_frame_ring"), now);
            }
        }
        if (Minecraft.getInstance().hasSingleplayerServer()) return;
        for (Rule rule : RULES) {
            if (!rule.dimension().equals(dimension)) continue;
            Evidence marker = observation.clues().get(rule.anchor());
            if (marker == null || rule.minimum().entrySet().stream()
                .anyMatch(required -> nearby.getOrDefault(required.getKey(), 0) < required.getValue())) continue;
            if (rule.anchor() == Clue.CRYING_OBSIDIAN && neighbors.values().stream()
                .map(sample -> sample.clues().get(Clue.NETHERRACK))
                .noneMatch(rock -> rock != null && rock.bounds().inflate(4).contains(
                    marker.first().getX() + 0.5, marker.first().getY() + 0.5, marker.first().getZ() + 0.5))) continue;
            rememberOutline(rule, marker.first(), neighbors);
            found(rule.type(), marker.first(), rule.minimum().keySet().stream().sorted()
                .map(clue -> clue.name().toLowerCase(Locale.ROOT)).toList(), now);
        }
    }

    private BlockPos endPortalCenter(BlockPos frame) {
        for (int dz = -2; dz <= 2; dz++) for (int dx = -2; dx <= 2; dx++) {
            if (!(Math.abs(dx) == 2 && Math.abs(dz) <= 1 || Math.abs(dz) == 2 && Math.abs(dx) <= 1)) continue;
            BlockPos center = frame.offset(dx, 0, dz);
            boolean ring = true;
            for (int i = -1; i <= 1 && ring; i++) {
                ring = isFrame(center.offset(i, 0, -2)) && isFrame(center.offset(i, 0, 2)) &&
                    isFrame(center.offset(-2, 0, i)) && isFrame(center.offset(2, 0, i));
            }
            if (ring) return center;
        }
        return null;
    }

    private boolean isFrame(BlockPos pos) {
        return level.getBlockState(pos).is(Blocks.END_PORTAL_FRAME);
    }

    private void rememberOutline(Rule rule, BlockPos anchor, Map<Chunk, Observation> neighbors) {
        AABB bounds = new AABB(anchor);
        Map<Chunk, AABB> parts = new LinkedHashMap<>();
        for (var sample : neighbors.entrySet()) {
            AABB part = null;
            for (Clue clue : rule.minimum().keySet()) {
                if (clue == Clue.SANDSTONE || clue == Clue.MOSSY_COBBLESTONE || clue == Clue.NETHERRACK) continue;
                Evidence feature = sample.getValue().clues().get(clue);
                if (feature == null || Math.abs(feature.first().getY() - anchor.getY()) > 28) continue;
                AABB b = feature.bounds();
                AABB clipped = new AABB(b.minX, Math.max(b.minY, anchor.getY() - 28), b.minZ,
                    b.maxX, Math.min(b.maxY, anchor.getY() + 29), b.maxZ);
                part = part == null ? clipped : part.minmax(clipped);
            }
            if (part != null) {
                parts.put(sample.getKey(), part);
                bounds = bounds.minmax(part);
            }
        }
        int pad = switch (rule.type()) {
            case "village", "desert_pyramid" -> 6;
            case "jungle_temple" -> 4;
            default -> 1;
        };
        bounds = bounds.inflate(pad, pad, pad);
        for (var entry : estimates.entrySet()) {
            Estimate previous = entry.getValue();
            BlockPos pos = previous.anchor();
            if (!previous.outline().type().equals(rule.type()) ||
                Math.abs(pos.getY() - anchor.getY()) > 24 ||
                Math.hypot(pos.getX() - anchor.getX(), pos.getZ() - anchor.getZ()) > 52) continue;
            Map<Chunk, AABB> combined = new LinkedHashMap<>(previous.parts());
            parts.forEach((chunk, piece) -> combined.merge(chunk, piece, AABB::minmax));
            entry.setValue(new Estimate(pos, new ObserverStructureOverlay12111.Outline(rule.type(),
                previous.outline().bounds().minmax(bounds), List.copyOf(combined.values()), true), combined));
            return;
        }
        estimates.put(rule.type() + '/' + anchor.asLong(),
            new Estimate(anchor, new ObserverStructureOverlay12111.Outline(rule.type(), bounds, List.copyOf(parts.values()), true), parts));
    }

    List<ObserverStructureOverlay12111.Outline> outlines() {
        return estimates.values().stream().map(Estimate::outline).toList();
    }

    void reportExact(List<ObserverStructureOverlay12111.Outline> outlines) {
        if (level == null) return;
        long now = System.currentTimeMillis();
        for (var outline : outlines) {
            var center = outline.bounds().getCenter();
            found(outline.type(), BlockPos.containing(center), List.of("structure_start", "structure_bounds"), now);
        }
    }

    private void found(String type, BlockPos pos, List<String> evidence, long now) {
        String key = world + '\n' + dimension + '\n' + type + '\n' + pos.asLong();
        if (seen.put(key, now) == null) {
            outbox.put(key, new Report(type, world, dimension, new int[]{pos.getX(), pos.getY(), pos.getZ()}, evidence));
        }
    }

    private void flush(long now) {
        if (upload != null) {
            if (!upload.result().isDone()) return;
            if (upload.result().getNow(false)) {
                upload.keys().forEach(outbox::remove);
                reported += upload.keys().size();
            } else {
                nextUpload = now + RETRY_MS;
            }
            upload = null;
        }
        if (outbox.isEmpty() || now < nextUpload) return;
        List<String> keys = outbox.keySet().stream().limit(BATCH_SIZE).toList();
        List<Report> batch = keys.stream().map(outbox::get).toList();
        HttpRequest request = HttpRequest.newBuilder(ENDPOINT).timeout(Duration.ofSeconds(2))
            .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(JSON.toJson(batch))).build();
        upload = new Upload(keys, HTTP.sendAsync(request, HttpResponse.BodyHandlers.discarding())
            .handle((response, error) -> error == null && response.statusCode() == 200));
    }
}
