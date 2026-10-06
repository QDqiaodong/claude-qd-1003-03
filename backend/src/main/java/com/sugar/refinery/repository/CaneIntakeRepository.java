package com.sugar.refinery.repository;

import java.util.List;
import java.util.Optional;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.sugar.refinery.entity.CaneIntake;

import jakarta.persistence.LockModeType;

public interface CaneIntakeRepository extends JpaRepository<CaneIntake, Long> {

    Optional<CaneIntake> findByTicketNo(String ticketNo);

    List<CaneIntake> findByStatus(String status);

    List<CaneIntake> findByResult(String result);

    List<CaneIntake> findBySupplier(String supplier);

    /**
     * 组合筛选：验收状态与品质结论按「同时满足」过滤；
     * 为 null / 空白的参数不参与限制（单条件、双条件、无条件都走这一个口径）。
     */
    @Query("""
            select c from CaneIntake c
            where (:status is null or c.status = :status)
              and (:result is null or c.result = :result)
            order by c.intakeAt desc, c.id desc
            """)
    List<CaneIntake> search(@Param("status") String status, @Param("result") String result);

    /** 行锁（SELECT ... FOR UPDATE）：投料交接扣减余量时串行化同一磅单的并发分配 */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select c from CaneIntake c where c.id = :id")
    Optional<CaneIntake> lockById(@Param("id") Long id);
}
