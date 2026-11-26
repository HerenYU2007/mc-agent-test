package com.nmo.agentobserver;

import com.google.gson.Gson;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.chunk.status.ChunkStatus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

final class ObserverOres12111 {
    private static final Logger LOG = LoggerFactory.getLogger("nmo-observer-survey");
    private static final int BATCH_SIZE = 128;
    private static final int CHUNK_COUNT = 9;
    private static final Gson JSON = new Gson();
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build();
    private static final URI ENDPOINT = URI.create("http://127.0.0.1:"
        + Integer.getInteger("nmo.observer.port", 3001) + "/observer/ores");

    private record Ore(String name, int[] pos) {}
    private record Scan(String id, String dimension, String session, String username, long sampledAt) {}
    private record Report(String session, String username, String dimension, double[] seenBot, long sampledAt,
                          String requestId, int batch, int batches, List<Ore> ores) {}

    private final List<ChunkPos> queue = new ArrayList<>(CHUNK_COUNT);
    private final List<Ore> ores = new ArrayList<>();
    private final Map<Block, String> minerals = new HashMap<>();
    private ClientLevel level;
    private Scan scan;
    private int chunkIndex;
    private int sectionIndex;
    private String completedId = "";
    private String label = "";
    private CompletableFuture<Boolean> delivery;
    private long retryAfter;

    void register(ObserverSettings12111 settings) {
        ClientTickEvents.END_CLIENT_TICK.register(this::tick);
        HudElementRegistry.addLast(Identifier.fromNamespaceAndPath("nmo-observer-survey", "summary"), (gui, delta) -> {
            Minecraft mc = Minecraft.getInstance();
            if (!settings.enabled(ObserverSettings12111.Display.SCAN_INFO) ||
                mc.level == null || mc.options.hideGui || mc.screen != null || label.isEmpty()) return;
            gui.drawString(mc.font, label, 6, gui.guiHeight() - 58, 0xFFAAEDDB, true);
        });
    }

    private void start(ClientLevel world, ObserverTelemetry.OreSurvey request, String session, String username) {
        level = world;
        scan = new Scan(request.id(), request.dimension(), session, username, System.currentTimeMillis());
        queue.clear();
        for (int dz = -1; dz <= 1; dz++) {
            for (int dx = -1; dx <= 1; dx++) {
                queue.add(new ChunkPos(request.chunkX() + dx, request.chunkZ() + dz));
            }
        }
        minerals.clear();
        for (Block block : BuiltInRegistries.BLOCK) {
            String name = BuiltInRegistries.BLOCK.getKey(block).getPath();
            if (request.names().contains(name)) minerals.put(block, name);
        }
        ores.clear();
        chunkIndex = sectionIndex = 0;
        retryAfter = 0;
    }

    private void tick(Minecraft mc) {
        if (delivery != null) {
            if (!delivery.isDone()) return;
            if (delivery.getNow(false)) {
                completedId = scan.id();
                label = "3×3 区块矿点已上报 " + ores.size() + " 个";
                LOG.info("矿点上报完成 bot={} dimension={} chunks={} count={}",
                    scan.username(), scan.dimension(), CHUNK_COUNT, ores.size());
            } else {
                label = "矿点上报待重试";
                retryAfter = System.nanoTime() + Duration.ofSeconds(1).toNanos();
            }
            delivery = null;
        }
        var request = ObserverTelemetry.oreSurvey;
        var frame = ObserverTelemetry.frame();
        String session = ObserverTelemetry.surveySession;
        if (request == null) return;
        if (mc.level == null || mc.player == null || session.isEmpty() || frame.position() == null ||
            !mc.level.dimension().identifier().getPath().equals(request.dimension())) return;
        if (request.id().equals(completedId)) return;
        var bot = mc.level.players().stream().filter(player -> player.getGameProfile().name().equals(frame.username()))
            .findFirst().orElse(null);
        if (bot == null || bot.distanceToSqr(frame.position().x(), frame.position().y(), frame.position().z()) > 64 ||
            bot.chunkPosition().x != request.chunkX() || bot.chunkPosition().z != request.chunkZ()) {
            label = "等待同世界 Bot 和目标区块";
            return;
        }
        if (mc.level != level || scan == null || !request.id().equals(scan.id())) {
            start(mc.level, request, session, frame.username());
        }
        if (System.nanoTime() < retryAfter) return;
        long deadline = System.nanoTime() + 1_500_000L;
        while (chunkIndex < queue.size() && System.nanoTime() < deadline) {
            ChunkPos pos = queue.get(chunkIndex);
            LevelChunk chunk = level.getChunkSource().getChunk(pos.x, pos.z, ChunkStatus.FULL, false);
            if (chunk == null) {
                label = "等待加载 3×3 区块 " + chunkIndex + "/" + CHUNK_COUNT;
                return;
            }
            LevelChunkSection section = chunk.getSections()[sectionIndex];
            if (section.maybeHas(state -> minerals.containsKey(state.getBlock()))) {
                scanSection(pos, chunk.getSectionYFromSectionIndex(sectionIndex), section);
            }
            if (++sectionIndex == chunk.getSections().length) {
                chunkIndex++;
                sectionIndex = 0;
            }
        }
        if (chunkIndex < queue.size()) {
            label = "扫描 Bot 周围 3×3 区块 " + chunkIndex + "/" + CHUNK_COUNT;
            return;
        }
        label = "正在上报 3×3 区块矿点";
        var found = List.copyOf(ores);
        var completedScan = scan;
        double[] seenBot = { bot.getX(), bot.getY(), bot.getZ() };
        delivery = CompletableFuture.supplyAsync(() -> publish(completedScan, seenBot, found));
    }

    private void scanSection(ChunkPos chunk, int sectionY, LevelChunkSection section) {
        for (int y = 0; y < 16; y++) for (int z = 0; z < 16; z++) for (int x = 0; x < 16; x++) {
            String name = minerals.get(section.getBlockState(x, y, z).getBlock());
            if (name != null) ores.add(new Ore(name, new int[]{
                chunk.getMinBlockX() + x, sectionY * 16 + y, chunk.getMinBlockZ() + z
            }));
        }
    }

    private static boolean publish(Scan scan, double[] seenBot, List<Ore> found) {
        int batches = Math.max(1, (found.size() + BATCH_SIZE - 1) / BATCH_SIZE);
        for (int batch = 0; batch < batches; batch++) {
            int offset = batch * BATCH_SIZE;
            var part = found.subList(offset, Math.min(offset + BATCH_SIZE, found.size()));
            var report = new Report(scan.session(), scan.username(), scan.dimension(), seenBot, scan.sampledAt(),
                scan.id(), batch, batches, part);
            HttpRequest request = HttpRequest.newBuilder(ENDPOINT).timeout(Duration.ofSeconds(2))
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(JSON.toJson(report)))
                .build();
            try {
                if (HTTP.send(request, HttpResponse.BodyHandlers.discarding()).statusCode() != 200) return false;
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                return false;
            } catch (java.io.IOException error) {
                return false;
            }
        }
        return true;
    }
}
