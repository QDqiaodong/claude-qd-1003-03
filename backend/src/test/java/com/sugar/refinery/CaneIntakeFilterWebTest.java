package com.sugar.refinery;

import java.math.BigDecimal;
import java.time.LocalDateTime;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.web.servlet.MockMvc;

import com.sugar.refinery.composite.JuiceQuality;
import com.sugar.refinery.entity.CaneIntake;
import com.sugar.refinery.repository.CaneIntakeRepository;
import com.sugar.refinery.service.CaneIntakeService;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 甘蔗进厂磅单筛选闭环测试。
 *
 * <p>覆盖：无条件全量、验收状态单条件、品质结论单条件、双条件「同时满足」组合、
 * 组合无命中保持空列表（不得回退全部）、非法取值报错，以及「今日进厂总量」
 * 固定按全厂当日有效磅单统计、不受列表条件与昨日磅单影响。</p>
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class CaneIntakeFilterWebTest {

    @Autowired private MockMvc mvc;
    @Autowired private CaneIntakeService intakeService;
    @Autowired private CaneIntakeRepository intakeRepository;

    private Long aId; // 合格 / 待验 / 今日
    private Long bId; // 合格 / 已验收 / 今日
    private Long cId; // 扣杂 / 待验 / 今日
    private Long dId; // 拒收 / 已拒收 / 今日
    private Long eId; // 合格 / 已验收 / 今日
    private Long fId; // 合格 / 已验收 / 昨日（不计入今日总量）

    @BeforeEach
    void setUp() {
        intakeRepository.deleteAll();
        LocalDateTime now = LocalDateTime.now();
        aId = save("CI-F-A", "合格", "待验", 32000, 12000, 400, now).getId();
        bId = save("CI-F-B", "合格", "已验收", 30500, 11800, 700, now).getId();
        cId = save("CI-F-C", "扣杂", "待验", 28800, 11500, 800, now).getId();
        dId = save("CI-F-D", "拒收", "已拒收", 30000, 12000, 1000, now).getId();
        eId = save("CI-F-E", "合格", "已验收", 33200, 12100, 800, now).getId();
        fId = save("CI-F-F", "合格", "已验收", 22000, 11000, 1000, now.minusDays(1)).getId();
    }

    @Test
    void filters_work_alone_and_combined_as_intersection() {
        // 无条件：全部磅单
        assertEquals(6, intakeService.list(null, null).size());
        assertEquals(6, intakeService.list("  ", "").size());

        // 单条件：验收状态
        assertEquals(java.util.List.of(aId, cId),
                ids(intakeService.list("待验", null)));

        // 单条件：品质结论
        assertEquals(java.util.List.of(dId),
                ids(intakeService.list(null, "拒收")));
        assertEquals(java.util.List.of(cId),
                ids(intakeService.list(null, "扣杂")));

        // 双条件：必须同时满足。旧实现只吃 status，会把昨日的 F 也带出来
        assertEquals(java.util.List.of(bId, eId, fId),
                ids(intakeService.list("已验收", "合格")));

        // 待验 + 拒收：数据里没有这种磅单，合法空结果必须保持空，不能回退全部
        assertEquals(0, intakeService.list("待验", "拒收").size());
        assertEquals(0, intakeService.list("已拒收", "合格").size());
    }

    @Test
    void illegal_filter_value_is_rejected_instead_of_returning_all() {
        assertThrows(com.sugar.refinery.common.BizException.class,
                () -> intakeService.list("已发车", null));
        assertThrows(com.sugar.refinery.common.BizException.class,
                () -> intakeService.list(null, "优秀"));
    }

    @Test
    void http_passes_both_params_and_empty_result_stays_empty() throws Exception {
        // 双条件同时下发，接口必须两个都应用
        mvc.perform(get("/api/cane-intakes").param("status", "已验收").param("result", "合格"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ok").value(true))
                .andExpect(jsonPath("$.data.length()").value(3));

        // 无命中：返回空数组而不是全部磅单
        mvc.perform(get("/api/cane-intakes").param("status", "待验").param("result", "拒收"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ok").value(true))
                .andExpect(jsonPath("$.data.length()").value(0));

        // 单条件
        mvc.perform(get("/api/cane-intakes").param("result", "扣杂"))
                .andExpect(jsonPath("$.data.length()").value(1))
                .andExpect(jsonPath("$.data[0].ticketNo").value("CI-F-C"));

        // 非法取值：400 + 中文提示，不能静默回退
        mvc.perform(get("/api/cane-intakes").param("status", "已发车"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.ok").value(false))
                .andExpect(jsonPath("$.message").value(org.hamcrest.Matchers.containsString("验收状态不合法")));
    }

    @Test
    void daily_ton_counts_all_valid_tickets_today_ignoring_filters() {
        // 今日有效磅单：A 19.60 + B 18.00 + C 16.50 + E 20.30 = 74.40
        // D 已拒收不计；F 是昨日不计。与列表筛选无关，口径恒定
        assertEquals(new BigDecimal("74.40"), intakeService.dailyIntakeTon());

        // 即使按某个条件把列表筛空 / 筛窄，今日总量仍是全厂口径
        intakeService.list("待验", "拒收");
        intakeService.list("已验收", "合格");
        assertEquals(new BigDecimal("74.40"), intakeService.dailyIntakeTon());
    }

    private CaneIntake save(String no, String result, String status,
                            int gross, int tare, int ded, LocalDateTime at) {
        CaneIntake c = new CaneIntake();
        c.setTicketNo(no);
        c.setSupplier("测试蔗农");
        c.setTruckNo("桂T" + no);
        c.setGrossKg(BigDecimal.valueOf(gross));
        c.setTareKg(BigDecimal.valueOf(tare));
        c.setDeductionKg(BigDecimal.valueOf(ded));
        c.setNetKg(BigDecimal.valueOf(gross - tare - ded));
        c.setAllocatedKg(BigDecimal.ZERO);
        c.setQuality(new JuiceQuality(new BigDecimal("13.50"), new BigDecimal("86.00"), new BigDecimal("12.50")));
        c.setResult(result);
        c.setStatus(status);
        c.setIntakeAt(at);
        return intakeRepository.save(c);
    }

    private java.util.List<Long> ids(java.util.List<CaneIntake> rows) {
        return rows.stream().map(CaneIntake::getId).sorted().toList();
    }
}
