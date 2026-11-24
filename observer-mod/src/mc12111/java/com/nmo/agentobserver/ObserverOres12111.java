package com.nmo.agentobserver;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.TimeUnit;
import com.google.gson.Gson;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.PriorityQueue;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.chunk.status.ChunkStatus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

final class ObserverOres12111 {
    private static final Logger LOG = LoggerFactory.getLogger("nmo-observer-survey");
    private static final int RADIUS = 4;
    private final List<ChunkPos> queue = new ArrayList<>();
    private ClientLevel level;
    private ChunkPos center;
    private BlockPos origin, nearest;
    private Block target;
    private int chunkIndex, sectionIndex, loaded, total, sealed;
    private long started, finished, firstMs;
    private boolean running;
    private String line = "";
    private record Ore(String name, int[] pos) {}
    private record Report(String session, String username, String dimension, double[] seenBot, long sampledAt, List<Ore> ores) {}
    private record Candidate(BlockPos pos, double distance) {}
    private final PriorityQueue<Candidate> nearby = new PriorityQueue<>(Comparator.comparingDouble(Candidate::distance).reversed());
    private static final Gson JSON = new Gson();
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build();
    private static final URI ENDPOINT = URI.create("http://127.0.0.1:" + Integer.getInteger("nmo.observer.port", 3001) + "/observer/ores");
    private CompletableFuture<?> pending;
    private volatile String delivery = "";

    void register() {
        ClientTickEvents.END_CLIENT_TICK.register(this::tick);
        HudElementRegistry.addLast(Identifier.fromNamespaceAndPath("nmo-observer-survey","summary"), (gui, delta) -> {
            Minecraft mc = Minecraft.getInstance();
            if (mc.level == null || mc.options.hideGui || mc.screen != null || line.isEmpty()) return;
            gui.drawString(mc.font, line + delivery, 6, gui.guiHeight() - 58, 0xFFAAEDDB, true);
        });
    }
    private void start(ClientLevel world, ChunkPos chunk, BlockPos pos) {
        level = world;
        center = chunk;
        origin = pos;
        target = level.dimension().equals(Level.NETHER) ? Blocks.ANCIENT_DEBRIS : Blocks.DEEPSLATE_DIAMOND_ORE;
        queue.clear();
        for (int dz = -RADIUS; dz <= RADIUS; dz++)
            for (int dx = -RADIUS; dx <= RADIUS; dx++) queue.add(new ChunkPos(center.x + dx, center.z + dz));
        queue.sort(Comparator.comparingInt(p -> (p.x-center.x)*(p.x-center.x)+(p.z-center.z)*(p.z-center.z)));
        nearest = null;
        nearby.clear();
        chunkIndex = sectionIndex = loaded = total = sealed = 0;
        firstMs = -1;
        started = System.nanoTime();
        running = true;
        line = "矿物扫描中…";
    }
    private void tick(Minecraft mc) {
        if (mc.player == null || mc.level == null || mc.level.dimension().equals(Level.END)) {
            level = null; running = false; line = ""; return;
        }
        ChunkPos now = mc.player.chunkPosition();
        if (mc.level != level || !now.equals(center) || (!running && System.nanoTime()-finished > TimeUnit.SECONDS.toNanos(loaded < 9 ? 2 : 15)))
            start(mc.level,now,mc.player.blockPosition());
        if (!running) return;
        long deadline = System.nanoTime()+1_500_000L;
        while (chunkIndex < queue.size() && System.nanoTime() < deadline) {
            ChunkPos pos = queue.get(chunkIndex);
            LevelChunk chunk = level.getChunkSource().getChunk(pos.x,pos.z,ChunkStatus.FULL,false);
            if (chunk == null) { chunkIndex++; sectionIndex=0; continue; }
            if (sectionIndex == 0) loaded++;
            int sy = chunk.getSectionYFromSectionIndex(sectionIndex);
            LevelChunkSection section = chunk.getSections()[sectionIndex++];
            if (section.maybeHas(s -> s.is(target))) scanSection(pos,sy,section);
            if (sectionIndex == chunk.getSections().length) { chunkIndex++; sectionIndex=0; }
        }
        if (chunkIndex < queue.size()) return;
        running=false; finished=System.nanoTime();
        long ms=TimeUnit.NANOSECONDS.toMillis(finished-started);
        String type=target==Blocks.ANCIENT_DEBRIS?"远古残骸":"深层钻石";
        line=type+" · 六面封闭 "+sealed+(nearest==null?"":" · "+nearest.toShortString())+" · "+ms+" ms";
        LOG.info("扫描完成 dimension={} origin={} chunks={} target={} matches={} sealed={} closest={} firstSealedMs={} totalMs={}",
            level.dimension().identifier(),origin.toShortString(),loaded,type,total,sealed,
            nearest==null?"—":nearest.toShortString(),firstMs,ms);
        publish(mc);
    }

    private void publish(Minecraft mc) {
        ObserverFrame frame = ObserverTelemetry.frame();
        String session = ObserverTelemetry.surveySession;
        if (frame.position() == null || session.isEmpty()) {
            delivery = " · 等待 Bot 接收端";
            return;
        }
        var bot = level.players().stream().filter(p -> p.getGameProfile().name().equals(frame.username())).findFirst().orElse(null);
        if (bot == null || bot.distanceToSqr(frame.position().x(), frame.position().y(), frame.position().z()) > 64) {
            delivery = " · 等待同世界 Bot";
            return;
        }
        if (pending != null && !pending.isDone()) return;
        String name = BuiltInRegistries.BLOCK.getKey(target).getPath();
        List<Ore> ores = nearby.stream().sorted(Comparator.comparingDouble(Candidate::distance))
            .map(c -> new Ore(name, new int[]{c.pos().getX(), c.pos().getY(), c.pos().getZ()})).toList();
        Report report = new Report(session, frame.username(), level.dimension().identifier().getPath(),
            new double[]{bot.getX(),bot.getY(),bot.getZ()}, System.currentTimeMillis(), ores);
        HttpRequest request = HttpRequest.newBuilder(ENDPOINT).timeout(Duration.ofSeconds(2))
            .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(JSON.toJson(report))).build();
        pending = HTTP.sendAsync(request, HttpResponse.BodyHandlers.discarding()).handle((response,error) -> {
            boolean accepted = error == null && response.statusCode() == 200;
            delivery = accepted ? " · 已上报 " + ores.size() : " · 上报未确认";
            if (accepted) LOG.info("矿点上报完成 bot={} dimension={} count={}",report.username(),report.dimension(),ores.size());
            return null;
        });
    }
    private boolean loadedAt(BlockPos p) {
        return !level.isOutsideBuildHeight(p.getY()) && level.getChunkSource().getChunk(
            p.getX() >> 4, p.getZ() >> 4, ChunkStatus.FULL, false) != null;
    }
    private void scanSection(ChunkPos chunk,int sy, LevelChunkSection section) {
        for(int y=0;y<16;y++) for(int z=0;z<16;z++) for(int x=0;x<16;x++){
            if(!section.getBlockState(x,y,z).is(target)) continue;
            total++;
            BlockPos p=new BlockPos(chunk.getMinBlockX()+x,sy*16+y,chunk.getMinBlockZ()+z);
            boolean closed=true;
            for(Direction dir:Direction.values()){
                BlockPos other=p.relative(dir);
                if(!loadedAt(other)||!level.getBlockState(other).isSolidRender()){closed=false;break;}
            }
            if(!closed) continue;
            if(sealed++==0) firstMs=TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started);
            double distance = p.distSqr(origin);
            if (nearest == null || distance < nearest.distSqr(origin)) nearest = p;
            if (nearby.size() < 32 || distance < nearby.element().distance()) {
                if (nearby.size() == 32) nearby.remove();
                nearby.add(new Candidate(p,distance));
            }
        }
    }
}
