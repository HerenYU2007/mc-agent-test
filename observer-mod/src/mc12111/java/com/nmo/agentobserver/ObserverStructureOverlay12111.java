package com.nmo.agentobserver;

import com.mojang.blaze3d.pipeline.RenderPipeline;
import com.mojang.blaze3d.platform.DepthTestFunction;
import com.mojang.blaze3d.vertex.ByteBufferBuilder;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.client.rendering.v1.world.WorldRenderContext;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.client.renderer.rendertype.RenderSetup;
import net.minecraft.client.renderer.rendertype.RenderType;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.levelgen.structure.StructureStart;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import com.nmo.agentobserver.ObserverSettings12111.Display;
import org.slf4j.LoggerFactory;

final class ObserverStructureOverlay12111 implements AutoCloseable {
    record Outline(String type, AABB bounds, List<AABB> pieces, boolean estimated) {}
    private static final int DRAW_RANGE = 160;
    private static final int EXACT_CHUNK_RADIUS = 8;
    private static final int MAX_OUTLINES = 24;
    private static final int MAX_PIECES = 160;
    private static final RenderPipeline PIPELINE = RenderPipelines.register(
        RenderPipeline.builder(RenderPipelines.LINES_SNIPPET)
            .withLocation(Identifier.fromNamespaceAndPath("nmo-agent-observer", "pipeline/structure_bounds"))
            .withDepthTestFunction(DepthTestFunction.NO_DEPTH_TEST)
            .withDepthWrite(false)
            .build());
    private static final RenderType BOX_LINES = RenderType.create("nmo_structure_bounds",
        RenderSetup.builder(PIPELINE).createRenderSetup());

    private final ObserverStructures12111 scanner;
    private final ObserverSettings12111 settings;
    private final ByteBufferBuilder vertices = new ByteBufferBuilder(8192);
    private final MultiBufferSource.BufferSource buffers = MultiBufferSource.immediate(vertices);
    private ClientLevel world;
    private List<Outline> exact = List.of();
    private CompletableFuture<List<Outline>> pending;
    private long nextRead;
    private List<Outline> rendered = List.of();

    ObserverStructureOverlay12111(ObserverStructures12111 scanner, ObserverSettings12111 settings) {
        this.scanner = scanner;
        this.settings = settings;
    }

    void tick(Minecraft client) {
        if (world != client.level) {
            world = client.level;
            exact = rendered = List.of();
            pending = null;
            nextRead = 0;
        }
        if (world == null || client.player == null || !client.player.isSpectator() || !settings.enabled(Display.STRUCTURES)) {
            rendered = List.of();
            return;
        }
        IntegratedServer server = client.getSingleplayerServer();
        if (server == null) return;
        if (pending != null && pending.isDone()) {
            exact = pending.getNow(List.of());
            pending = null;
        }
        long now = System.nanoTime();
        if (pending == null && now >= nextRead) {
            nextRead = now + 1_000_000_000L;
            ResourceKey<Level> dimension = world.dimension();
            ChunkPos center = client.player.chunkPosition();
            pending = CompletableFuture.supplyAsync(() -> readExact(server, dimension, center), server)
                .exceptionally(error -> {
                    LoggerFactory.getLogger("nmo-observer-structures").warn("读取单人世界结构范围失败", error);
                    return List.of();
                });
        }
    }

    private static List<Outline> readExact(IntegratedServer server, ResourceKey<Level> dimension, ChunkPos center) {
        var level = server.getLevel(dimension);
        if (level == null) return List.of();
        var chunks = level.getChunkSource();
        var registry = level.registryAccess().lookupOrThrow(Registries.STRUCTURE);
        Set<StructureStart> starts = Collections.newSetFromMap(new IdentityHashMap<>());
        for (int dz = -EXACT_CHUNK_RADIUS; dz <= EXACT_CHUNK_RADIUS; dz++) {
            for (int dx = -EXACT_CHUNK_RADIUS; dx <= EXACT_CHUNK_RADIUS; dx++) {
                LevelChunk chunk = chunks.getChunkNow(center.x + dx, center.z + dz);
                if (chunk == null) continue;
                starts.addAll(chunk.getAllStarts().values());
                for (var reference : chunk.getAllReferences().entrySet()) {
                    for (long key : reference.getValue()) {
                        LevelChunk source = chunks.getChunkNow(ChunkPos.getX(key), ChunkPos.getZ(key));
                        if (source != null) starts.add(source.getStartForStructure(reference.getKey()));
                    }
                }
            }
        }
        return starts.stream().filter(start -> start != null && start.isValid()).map(start -> {
            var key = registry.getKey(start.getStructure());
            String type = key == null ? "structure" : key.getPath();
            return new Outline(type, box(start.getBoundingBox()),
                start.getPieces().stream().map(piece -> box(piece.getBoundingBox())).toList(), false);
        }).toList();
    }

    private static AABB box(BoundingBox source) {
        return new AABB(source.minX(), source.minY(), source.minZ(), source.maxX() + 1, source.maxY() + 1, source.maxZ() + 1);
    }

    void render(WorldRenderContext context) {
        Minecraft client = Minecraft.getInstance();
        rendered = List.of();
        if (client.level == null || client.player == null || !client.player.isSpectator() ||
            client.options.hideGui || !settings.enabled(Display.STRUCTURES)) return;
        Vec3 camera = context.worldState().cameraRenderState.pos;
        List<Outline> known = client.hasSingleplayerServer() ? exact : scanner.outlines();
        List<Outline> visible = known.stream()
            .filter(outline -> outline.bounds().distanceToSqr(camera) <= DRAW_RANGE * DRAW_RANGE)
            .sorted(Comparator.comparingDouble(outline -> outline.bounds().distanceToSqr(camera)))
            .limit(MAX_OUTLINES).toList();
        if (visible.isEmpty()) return;
        rendered = visible;
        PoseStack.Pose pose = context.matrices().last();
        VertexConsumer lines = buffers.getBuffer(BOX_LINES);
        boolean parts = settings.enabled(Display.STRUCTURE_PIECES);
        int drawnPieces = 0;
        for (Outline outline : visible) {
            int color = color(outline.type());
            drawBox(pose, lines, outline.bounds(), camera, color, 2.2F, outline.estimated());
            if (!parts) continue;
            for (AABB piece : outline.pieces()) {
                if (drawnPieces >= MAX_PIECES) break;
                if (!piece.equals(outline.bounds()) && piece.distanceToSqr(camera) <= DRAW_RANGE * DRAW_RANGE) {
                    drawBox(pose, lines, piece, camera, 0xFFB1CFD0, 1.15F, false);
                    drawnPieces++;
                }
            }
        }
        buffers.endBatch(BOX_LINES);
    }

    private static void drawBox(PoseStack.Pose pose, VertexConsumer lines, AABB box, Vec3 camera,
                                int color, float width, boolean dashed) {
        for (int i = 0; i < 8; i++) {
            Vec3 p = new Vec3((i & 1) == 0 ? box.minX : box.maxX, (i & 2) == 0 ? box.minY : box.maxY,
                (i & 4) == 0 ? box.minZ : box.maxZ).subtract(camera);
            if ((i & 1) == 0) edge(pose, lines, p, new Vec3(box.getXsize(), 0, 0), color, width, dashed);
            if ((i & 2) == 0) edge(pose, lines, p, new Vec3(0, box.getYsize(), 0), color, width, dashed);
            if ((i & 4) == 0) edge(pose, lines, p, new Vec3(0, 0, box.getZsize()), color, width, dashed);
        }
    }

    private static void edge(PoseStack.Pose pose, VertexConsumer lines, Vec3 start, Vec3 extent,
                             int color, float width, boolean dashed) {
        if (!dashed) {
            ObserverPath12111.line(pose, lines, start, start.add(extent), color, width);
            return;
        }
        double length = extent.length();
        Vec3 direction = extent.normalize();
        for (double distance = 0; distance < length; distance += 3.0) {
            ObserverPath12111.line(pose, lines, start.add(direction.scale(distance)),
                start.add(direction.scale(Math.min(length, distance + 1.85))), color, width);
        }
    }

    String legend() {
        if (rendered.isEmpty()) return "";
        List<String> names = rendered.stream().map(outline -> label(outline.type())).distinct().limit(3).toList();
        return (rendered.getFirst().estimated() ? "结构范围 · 联机估算" : "结构范围 · 原版边界")
            + " · " + String.join("、", names);
    }

    private static String label(String type) {
        if (type.startsWith("village")) return "村庄";
        return switch (type) {
            case "desert_pyramid" -> "沙漠神殿";
            case "jungle_temple", "jungle_pyramid" -> "丛林神庙";
            case "monument" -> "海底神殿";
            case "fortress" -> "下界要塞";
            case "bastion", "bastion_remnant" -> "堡垒遗迹";
            case "end_city" -> "末地城";
            default -> type.replace('_', ' ');
        };
    }

    private static int color(String type) {
        return switch (label(type)) {
            case "村庄" -> 0xFF79E9AC;
            case "沙漠神殿" -> 0xFFFFCB73;
            case "丛林神庙" -> 0xFFA9DC63;
            case "海底神殿" -> 0xFF64D7FF;
            case "下界要塞" -> 0xFFFCA264;
            case "堡垒遗迹" -> 0xFFFFD677;
            case "末地城" -> 0xFFD1A0FF;
            default -> 0xFFB6D9E5;
        };
    }

    @Override public void close() { vertices.close(); }
}
